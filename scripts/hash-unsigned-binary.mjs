import crypto from 'node:crypto';
import fs from 'node:fs';

const [binaryPath] = process.argv.slice(2);
if (process.argv.length !== 3 || !binaryPath) {
  console.error('Expected one Mach-O binary path');
  process.exit(2);
}

let binary;
try {
  binary = fs.readFileSync(binaryPath);
} catch (error) {
  console.error(
    `Could not read Mach-O binary: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const macho64Magic = 0xfeedfacf;
if (binary.length < 32 || binary.readUInt32LE(0) !== macho64Magic) {
  console.error('Expected a thin little-endian 64-bit Mach-O binary');
  process.exit(1);
}

const commandCount = binary.readUInt32LE(16);
const commandBytes = binary.readUInt32LE(20);
const commandEnd = 32 + commandBytes;
if (commandCount === 0 || commandEnd > binary.length) {
  console.error('Mach-O load commands are outside the binary');
  process.exit(1);
}

const normalized = Buffer.from(binary);
let commandOffset = 32;
let linkeditSegments = 0;
for (let index = 0; index < commandCount; index += 1) {
  if (commandOffset + 8 > commandEnd) {
    console.error('Mach-O load command header is truncated');
    process.exit(1);
  }
  const command = binary.readUInt32LE(commandOffset);
  const commandSize = binary.readUInt32LE(commandOffset + 4);
  if (commandSize < 8 || commandOffset + commandSize > commandEnd) {
    console.error('Mach-O load command is malformed');
    process.exit(1);
  }

  if (command === 0x1d) {
    // The shell wrapper must remove a valid embedded signature first. Rejecting a remaining
    // command prevents an invalid or partially stripped signature from being treated as identity.
    console.error('Mach-O code signature was not removed');
    process.exit(1);
  }

  if (command === 0x19 && commandSize >= 72) {
    const segmentName = binary
      .subarray(commandOffset + 8, commandOffset + 24)
      .toString('ascii')
      .replace(/\0+$/, '');
    if (segmentName === '__LINKEDIT') {
      // Xcode expands __LINKEDIT.vmsize while appending its normal code signature. The value is
      // loader metadata, not runtime bytes, and is the only post-signing field we intentionally
      // normalize. Keep the executable content, UUID, load paths, and all other load commands
      // covered by the digest.
      normalized.fill(0, commandOffset + 32, commandOffset + 40);
      linkeditSegments += 1;
    }
  }
  commandOffset += commandSize;
}

if (commandOffset !== commandEnd || linkeditSegments === 0) {
  console.error('Mach-O does not contain a complete __LINKEDIT segment');
  process.exit(1);
}

process.stdout.write(`${crypto.createHash('sha256').update(normalized).digest('hex')}\n`);
