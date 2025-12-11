const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'uploads', 'test.wav');
// Minimal WAV header for 1 second of silence, 16-bit mono, 16kHz
const header = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // 'RIFF'
    0x24, 0x00, 0x00, 0x00, // Chunk size (36 + data)
    0x57, 0x41, 0x56, 0x45, // 'WAVE'
    0x66, 0x6d, 0x74, 0x20, // 'fmt '
    0x10, 0x00, 0x00, 0x00, // Subchunk1Size (16)
    0x01, 0x00, // AudioFormat (1 = PCM)
    0x01, 0x00, // NumChannels (1)
    0x80, 0x3e, 0x00, 0x00, // SampleRate (16000)
    0x00, 0x7d, 0x00, 0x00, // ByteRate (SampleRate*NumChannels*BitsPerSample/8)
    0x02, 0x00, // BlockAlign (NumChannels*BitsPerSample/8)
    0x10, 0x00, // BitsPerSample (16)
    0x64, 0x61, 0x74, 0x61, // 'data'
    0x00, 0x00, 0x00, 0x00 // Subchunk2Size (0)
]);
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
fs.writeFileSync(filePath, header);
console.log('dummy wav created at', filePath);
