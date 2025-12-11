const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');

// Ensure ffmpeg uses the static binary
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Compress an input audio file to 16kHz mono WAV with low bitrate.
 * @param {string} inputPath - Path to the original uploaded audio file.
 * @param {string} outputPath - Desired path for the compressed output file.
 * @returns {Promise<void>} Resolves when compression finishes.
 */
function compressAudio(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                '-ar 16000', // sample rate 16kHz
                '-ac 1',    // mono channel
                '-b:a 64k', // audio bitrate 64kbps
                '-f wav'    // force WAV container
            ])
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

module.exports = { compressAudio };
