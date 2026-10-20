// Text-to-speech interface. The simulator speaks with the browser (speechSynthesis) unless the server has a TTS
// provider: POST /tts { text } -> audio/mpeg. Amazon Polly (neural voice) is the AWS provider (live on the public
// demo): MANDAT_TTS=polly, MANDAT_POLLY_VOICE (default "Danielle"), AWS_REGION. The SDK is imported
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
// How "Mandat" is said (seen on 20 Oct: the English voice said "Mondaw" / "Manda"). SSML <phoneme> in IPA, supported by
// Polly neural voices: English "MAN-dat", Spanish "MAN-dat"; in French "Mandat" is the French word (/mɑ̃.da/) and Léa
// already says it right, so the text is left as it is. Tags are not billed; the text is escaped for SSML.
export const NAME_IPA = { en: 'ˈmæn.dæt', es: 'ˈman.dat' };
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export function pollyInput(text, voice = process.env.MANDAT_POLLY_VOICE || 'Danielle', locale = 'en-US') {
  const t = String(text).slice(0, 1500);
  const ipa = NAME_IPA[String(locale || 'en').slice(0, 2).toLowerCase()];
  if (!ipa || !/\bMandat\b/i.test(t)) return { Engine: 'neural', OutputFormat: 'mp3', VoiceId: voice, Text: t, TextType: 'text' };
  const ssml = xml(t).replace(/\bMandat\b/gi, (w) => `<phoneme alphabet="ipa" ph="${ipa}">${w}</phoneme>`);
  return { Engine: 'neural', OutputFormat: 'mp3', VoiceId: voice, Text: `<speak>${ssml}</speak>`, TextType: 'ssml' };
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
      const out = await client.send(new sdk.SynthesizeSpeechCommand(pollyInput(text, voiceFor(locale), locale)));
      return Buffer.from(await out.AudioStream.transformToByteArray());
    },
  };
}
