export interface ProtoField { field: number; wire: number; num?: bigint; sub?: Uint8Array }

/** Read the protobuf wire format used by the public game resource manifests. */
export function* fields(input: Uint8Array): Generator<ProtoField> {
  let offset = 0
  const invalid = () => new Error('游戏文件清单的 protobuf 数据无效')
  function varint(): bigint {
    let result = 0n
    for (let shift = 0n; shift < 70n && offset < input.length; shift += 7n) {
      const value = input[offset++]
      if (shift === 63n && value > 1) throw invalid()
      result |= BigInt(value & 127) << shift
      if (!(value & 128)) return result
    }
    throw invalid()
  }
  while (offset < input.length) {
    const key = varint(), field = Number(key >> 3n), wire = Number(key & 7n)
    if (!field || field > 0x1fffffff) throw invalid()
    if (wire === 0) yield { field, wire, num: varint() }
    else if (wire === 2) {
      const length = Number(varint())
      if (length > input.length - offset) throw invalid()
      const sub = input.subarray(offset, offset + length)
      offset += length
      yield { field, wire, sub }
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4
      if (offset > input.length) throw invalid()
    } else throw invalid()
  }
}
