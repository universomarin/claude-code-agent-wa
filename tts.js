const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');

const AUDIO_DIR = './audio_tmp';

function textToSpeech(text) {
  if (!config.ELEVENLABS_API_KEY || !config.ELEVENLABS_VOICE_ID) {
    return Promise.reject(new Error('ElevenLabs not configured'));
  }

  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

  const timestamp = Date.now();
  const mp3Path = path.join(AUDIO_DIR, `tts_${timestamp}.mp3`);
  const oggPath = path.join(AUDIO_DIR, `tts_${timestamp}.ogg`);

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    });

    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: `/v1/text-to-speech/${config.ELEVENLABS_VOICE_ID}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': config.ELEVENLABS_API_KEY,
        'Accept': 'audio/mpeg'
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => reject(new Error(`ElevenLabs API ${res.statusCode}: ${body}`)));
        return;
      }

      const fileStream = fs.createWriteStream(mp3Path);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        try {
          execSync(`ffmpeg -i "${mp3Path}" -c:a libopus -b:a 64k "${oggPath}" -y 2>/dev/null`);
          try { fs.unlinkSync(mp3Path); } catch {}
          resolve(oggPath);
        } catch (err) {
          reject(new Error(`ffmpeg conversion failed: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

module.exports = { textToSpeech };
