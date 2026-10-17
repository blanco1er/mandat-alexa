// Text-to-speech interface. The simulator speaks with the browser (speechSynthesis) unless the server has a TTS
// provider: POST /tts { text } -> audio/mpeg. Amazon Polly (neural voice) is the AWS provider, stubbed until the
// account exists: MANDAT_TTS=polly, MANDAT_POLLY_VOICE (default "Danielle"), AWS_REGION. The SDK is imported
// lazily (@aws-sdk/client-polly, bundled in the Lambda Node.js runtime). Default: none -> 501, browser voice.
export function pollyInput(text, voice = process.env.MANDAT_POLLY_VOICE || 'Danielle') {
  return { Engine: 'neural', OutputFormat: 'mp3', VoiceId: voice, Text: String(text).slice(0, 1500), TextType: 'text' };
}

export function createTts(kind = process.env.MANDAT_TTS || 'browser') {
  if (kind !== 'polly') return null;
  let client = null, sdk = null;
  return {
    name: 'polly',
    async synthesize(text) {
      if (!client) {
        try { sdk = await import('@aws-sdk/client-polly'); } catch { throw new Error('MANDAT_TTS=polly needs @aws-sdk/client-polly (bundled in the Lambda Node.js runtime).'); }
        client = new sdk.PollyClient({ region: process.env.AWS_REGION || 'us-east-1' });
      }
      const out = await client.send(new sdk.SynthesizeSpeechCommand(pollyInput(text)));
      return Buffer.from(await out.AudioStream.transformToByteArray());
    },
  };
}
