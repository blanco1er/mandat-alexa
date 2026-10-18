// Text-to-speech interface. The simulator speaks with the browser (speechSynthesis) unless the server has a TTS
// provider: POST /tts { text } -> audio/mpeg. Amazon Polly (neural voice) is the AWS provider, stubbed until the
// account exists: MANDAT_TTS=polly, MANDAT_POLLY_VOICE (default "Danielle"), AWS_REGION. The SDK is imported
// lazily (@aws-sdk/client-polly, bundled in the Lambda Node.js runtime). Default: none -> 501, browser voice.
// Neural voices per locale, checked in us-east-1 with describe-voices --engine neural (18 Oct 2026):
// fr-FR Lea / Remi, es-ES Lucia / Sergio, es-US Lupe / Pedro. English keeps MANDAT_POLLY_VOICE (default Danielle).
export const POLLY_VOICES = { 'fr-FR': 'Lea', 'es-ES': 'Lucia', 'es-US': 'Lupe' };
export function voiceFor(locale) {
  const l = String(locale || '').toLowerCase();
  if (l.startsWith('fr')) return POLLY_VOICES['fr-FR'];
  if (l === 'es-us' || l === 'es-mx' || l === 'es-419') return POLLY_VOICES['es-US'];
  if (l.startsWith('es')) return POLLY_VOICES['es-ES'];
  return process.env.MANDAT_POLLY_VOICE || 'Danielle';
}
export function pollyInput(text, voice = process.env.MANDAT_POLLY_VOICE || 'Danielle') {
  return { Engine: 'neural', OutputFormat: 'mp3', VoiceId: voice, Text: String(text).slice(0, 1500), TextType: 'text' };
}

export function createTts(kind = process.env.MANDAT_TTS || 'browser') {
  if (kind !== 'polly') return null;
  let client = null, sdk = null;
  return {
    name: 'polly',
    async synthesize(text, locale) {
      if (!client) {
        try { sdk = await import('@aws-sdk/client-polly'); } catch { throw new Error('MANDAT_TTS=polly needs @aws-sdk/client-polly (bundled in the Lambda Node.js runtime).'); }
        client = new sdk.PollyClient({ region: process.env.AWS_REGION || 'us-east-1' });
      }
      const out = await client.send(new sdk.SynthesizeSpeechCommand(pollyInput(text, voiceFor(locale))));
      return Buffer.from(await out.AudioStream.transformToByteArray());
    },
  };
}
