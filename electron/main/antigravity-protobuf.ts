function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  let current = value >>> 0
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80)
    current >>>= 7
  }
  bytes.push(current)
  return Buffer.from(bytes)
}

function readVarint(data: Buffer, offset: number): { value: number; offset: number } {
  let result = 0
  let shift = 0
  let pos = offset

  while (pos < data.length) {
    const byte = data[pos]
    result |= (byte & 0x7f) << shift
    pos += 1
    if ((byte & 0x80) === 0) {
      break
    }
    shift += 7
  }

  return { value: result >>> 0, offset: pos }
}

function skipField(data: Buffer, offset: number, wireType: number): number {
  switch (wireType) {
    case 0:
      return readVarint(data, offset).offset
    case 1:
      return offset + 8
    case 2: {
      const { value: length, offset: contentOffset } = readVarint(data, offset)
      return contentOffset + length
    }
    case 5:
      return offset + 4
    default:
      throw new Error(`unknown_wire_type: ${wireType}`)
  }
}

function encodeLenDelimField(fieldNum: number, payload: Buffer): Buffer {
  const tag = encodeVarint((fieldNum << 3) | 2)
  const length = encodeVarint(payload.length)
  return Buffer.concat([tag, length, payload])
}

function encodeStringField(fieldNum: number, value: string): Buffer {
  return encodeLenDelimField(fieldNum, Buffer.from(value, 'utf8'))
}

function encodeVarintField(fieldNum: number, value: number): Buffer {
  const tag = encodeVarint((fieldNum << 3) | 0)
  const data = encodeVarint(value)
  return Buffer.concat([tag, data])
}

function unifiedTopicEntryKey(data: Buffer): string | null {
  let offset = 0
  while (offset < data.length) {
    const { value: tag, offset: newOffset } = readVarint(data, offset)
    const wireType = tag & 7
    const fieldNum = tag >>> 3

    if (fieldNum === 1 && wireType === 2) {
      const { value: length, offset: contentOffset } = readVarint(data, newOffset)
      return data.subarray(contentOffset, contentOffset + length).toString('utf8')
    }

    offset = skipField(data, newOffset, wireType)
  }
  return null
}

export function removeUnifiedTopicEntry(data: Buffer, targetKey: string): Buffer {
  const result: Buffer[] = []
  let offset = 0

  while (offset < data.length) {
    const startOffset = offset
    const { value: tag, offset: newOffset } = readVarint(data, offset)
    const wireType = tag & 7
    const fieldNum = tag >>> 3
    const nextOffset = skipField(data, newOffset, wireType)

    let shouldRemove = false
    if (fieldNum === 1 && wireType === 2) {
      const { value: length, offset: contentOffset } = readVarint(data, newOffset)
      const entry = data.subarray(contentOffset, contentOffset + length)
      shouldRemove = unifiedTopicEntryKey(entry) === targetKey
    }

    if (!shouldRemove) {
      result.push(data.subarray(startOffset, nextOffset))
    }
    offset = nextOffset
  }

  return Buffer.concat(result)
}

export function createUnifiedTopicEntry(sentinelKey: string, payload: Buffer): Buffer {
  const row = encodeStringField(1, payload.toString('base64'))
  const entry = Buffer.concat([
    encodeStringField(1, sentinelKey),
    encodeLenDelimField(2, row)
  ])
  return encodeLenDelimField(1, entry)
}

export function createUnifiedStateEntry(sentinelKey: string, payload: Buffer): string {
  const topic = createUnifiedTopicEntry(sentinelKey, payload)
  return topic.toString('base64')
}

function isPersonalEmail(email: string): boolean {
  const lower = email.toLowerCase()
  return (
    lower.endsWith('@gmail.com') ||
    lower.endsWith('@outlook.com') ||
    lower.endsWith('@hotmail.com') ||
    lower.endsWith('@qq.com') ||
    lower.endsWith('@163.com')
  )
}

export function createOAuthInfo(
  accessToken: string,
  refreshToken: string,
  expiry: number,
  email: string,
  isGcpTos = false
): Buffer {
  const useGcpTos = isPersonalEmail(email) ? false : isGcpTos

  const timestampMsg = Buffer.concat([
    encodeVarint((1 << 3) | 0),
    encodeVarint(expiry),
    encodeVarint((2 << 3) | 0),
    encodeVarint(0)
  ])

  const parts = [
    encodeStringField(1, accessToken),
    encodeStringField(2, 'Bearer'),
    encodeStringField(3, refreshToken),
    encodeLenDelimField(4, timestampMsg)
  ]

  if (useGcpTos) {
    parts.push(encodeVarintField(6, 1))
  }

  return Buffer.concat(parts)
}

export function createMinimalUserStatusPayload(email: string): Buffer {
  return Buffer.concat([encodeStringField(3, email), encodeStringField(7, email)])
}

export function createStringValuePayload(value: string): Buffer {
  return encodeStringField(3, value)
}
