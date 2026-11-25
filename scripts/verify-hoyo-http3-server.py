"""Loopback-only HTTPS and HTTP/3 fixture for the launcher transport smoke test."""

import argparse
import asyncio
import base64
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http import HTTPStatus
from ipaddress import ip_address
import json
from pathlib import Path
import re
import ssl

from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import HeadersReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ProtocolNegotiated
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


HOST = "127.0.0.1"
PAYLOAD = bytes(range(256)) * 1024
RANGE = re.compile(rb"bytes=(\d*)-(\d*)")
FIXTURES = {b"/fixtures/manifest": "manifest", b"/fixtures/chunk": "chunk"}


def certificate(run_dir):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "KevinLauncher HTTP3 Test")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip_address(HOST))]), False)
        .sign(key, hashes.SHA256())
    )
    cert_file, key_file = run_dir / "cert.pem", run_dir / "key.pem"
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ))
    public_key = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return cert_file, key_file, base64.b64encode(sha256(public_key).digest()).decode("ascii")


def byte_range(value, length):
    match = RANGE.fullmatch(value)
    if not match or not length:
        return None
    first, last = match.groups()
    if not first:
        suffix = int(last or b"0")
        return (max(0, length - suffix), length - 1) if suffix else None
    start, end = int(first), min(int(last), length - 1) if last else length - 1
    return (start, end) if start <= end else None


class Fixture:
    def __init__(self, run_dir):
        self.directory = run_dir
        self.evidence = run_dir / "requests.jsonl"
        self.port = 0

    def content(self, path):
        if path == b"/payload":
            return PAYLOAD
        if path == b"/warmup":
            return b"KevinLauncher HTTP/3 test\n"
        filename = FIXTURES.get(path)
        if filename:
            file = self.directory / filename
            if file.is_file() and not file.is_symlink():
                return file.read_bytes()
        return None

    def reply(self, protocol, method, target, request_headers):
        path = target.split(b"?", 1)[0]
        data = self.content(path)
        status = HTTPStatus.OK
        headers = [(b"content-type", b"application/octet-stream"), (b"accept-ranges", b"bytes"),
                   (b"cache-control", b"no-store")]
        if protocol == "http/1.1":
            headers.append((b"alt-svc", f'h3=":{self.port}"; ma=3600'.encode("ascii")))
        range_header = request_headers.get(b"range")
        if method not in (b"GET", b"HEAD"):
            status, data = HTTPStatus.METHOD_NOT_ALLOWED, b""
        elif data is None:
            status, data = HTTPStatus.NOT_FOUND, b""
        elif range_header is not None:
            length = len(data)
            selected = byte_range(range_header, length)
            if selected:
                start, end = selected
                headers.append((b"content-range", f"bytes {start}-{end}/{length}".encode("ascii")))
                status, data = HTTPStatus.PARTIAL_CONTENT, data[start:end + 1]
            else:
                headers.append((b"content-range", f"bytes */{length}".encode("ascii")))
                status, data = HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, b""
        headers.append((b"content-length", str(len(data)).encode("ascii")))
        body = b"" if method == b"HEAD" else data
        with self.evidence.open("a", encoding="utf-8") as log:
            log.write(json.dumps({
                "protocol": protocol,
                "method": method.decode("ascii"),
                "path": path.decode("ascii"),
                "range": range_header.decode("ascii") if range_header is not None else None,
                "status": int(status),
                "length": len(body),
            }) + "\n")
        return status, headers, body

    async def tcp_request(self, reader, writer):
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
            request, *headers, _, _ = raw.split(b"\r\n")
            method, target, _ = request.split(b" ")
            fields = {}
            for header in headers:
                key, value = header.split(b":", 1)
                fields[key.lower()] = value.strip()
            status, response_headers, body = self.reply("http/1.1", method, target, fields)
            writer.write(f"HTTP/1.1 {status.value} {status.phrase}\r\n".encode("ascii"))
            writer.write(b"".join(key + b": " + value + b"\r\n" for key, value in response_headers))
            writer.write(b"connection: close\r\n\r\n" + body)
            await writer.drain()
        except (ValueError, TimeoutError, ConnectionError, asyncio.IncompleteReadError,
                asyncio.LimitOverrunError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass


class Http3(QuicConnectionProtocol):
    def __init__(self, *args, fixture, **kwargs):
        super().__init__(*args, **kwargs)
        self.fixture = fixture
        self.http = None
        self.protocol = None

    def quic_event_received(self, event):
        if isinstance(event, ProtocolNegotiated) and event.alpn_protocol in H3_ALPN:
            self.http = H3Connection(self._quic)
            self.protocol = event.alpn_protocol
        if self.http is None:
            return
        for request in self.http.handle_event(event):
            if not isinstance(request, HeadersReceived):
                continue
            headers = dict(request.headers)
            status, fields, body = self.fixture.reply(
                self.protocol, headers[b":method"], headers[b":path"], headers
            )
            self.http.send_headers(
                request.stream_id, [(b":status", str(status.value).encode("ascii")), *fields],
                end_stream=not body
            )
            if body:
                self.http.send_data(request.stream_id, body, end_stream=True)
            self.transmit()


async def run(directory):
    directory.mkdir(parents=True, exist_ok=True)
    ready_file = directory / "ready.json"
    ready_file.unlink(missing_ok=True)
    fixture = Fixture(directory)
    fixture.evidence.write_text("", encoding="utf-8")
    cert, key, spki = certificate(directory)
    tcp_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tcp_tls.load_cert_chain(cert, key)
    tcp_tls.set_alpn_protocols(["http/1.1"])
    quic = QuicConfiguration(is_client=False, alpn_protocols=H3_ALPN)
    quic.load_cert_chain(cert, key)
    # An ephemeral TCP port is normally available for UDP too. Reserve both
    # before publishing readiness and retry if a UDP listener won that port.
    for _ in range(10):
        tcp = await asyncio.start_server(fixture.tcp_request, HOST, 0, ssl=tcp_tls)
        fixture.port = tcp.sockets[0].getsockname()[1]
        try:
            udp = await serve(
                HOST, fixture.port, configuration=quic,
                create_protocol=lambda *args, **kwargs: Http3(*args, fixture=fixture, **kwargs)
            )
            break
        except OSError:
            tcp.close()
            await tcp.wait_closed()
    else:
        raise OSError("Could not reserve the same TCP and UDP loopback port")
    try:
        info = {
            "origin": f"https://{HOST}:{fixture.port}",
            "port": fixture.port,
            "spki": spki,
            "evidence": str(fixture.evidence),
            "cert": str(cert),
            "payloadSize": len(PAYLOAD),
            "payloadSha256": sha256(PAYLOAD).hexdigest(),
        }
        temporary = ready_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(info) + "\n", encoding="utf-8")
        temporary.replace(ready_file)
        print(json.dumps(info), flush=True)
        await tcp.serve_forever()
    finally:
        udp.close()
        tcp.close()
        await tcp.wait_closed()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Isolated directory for temporary test files")
    arguments = parser.parse_args()
    try:
        asyncio.run(run(arguments.directory.resolve()))
    except KeyboardInterrupt:
        pass
