// Stardust shared AI proxy — deploy once and every Stardust user gets the AI
// features (DJ, voice, lyric learn, stats chat) with NO key of their own.
// The Groq key lives here as a secret; the app calls this with the anon key.
//
// Deploy (from the repo root, one time):
//   npx supabase functions deploy ai --project-ref ufztwzzdcnlhkjflfkgk --no-verify-jwt
//   npx supabase secrets set GROQ_KEY=gsk_... --project-ref ufztwzzdcnlhkjflfkgk
//
// Note: Groq's current TTS model (canopylabs/orpheus-v1-english) needs a
// one-time terms acceptance in the Groq console for the key's org.

const GROQ = 'https://api.groq.com/openai/v1';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: cors() });
  }
  const key = Deno.env.get('GROQ_KEY');
  if (!key) return json({ error: 'proxy-unconfigured' }, 500);
  let body: { kind?: string; payload?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'bad-request' }, 400); }
  const { kind, payload } = body;

  if (kind === 'ping') return json({ ok: true });

  if (kind === 'chat') {
    const r = await fetch(GROQ + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return new Response(await r.text(), { status: r.status, headers: cors('application/json') });
  }

  if (kind === 'tts') {
    const r = await fetch(GROQ + '/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) return new Response(await r.text(), { status: r.status, headers: cors('application/json') });
    return new Response(await r.arrayBuffer(), { status: 200, headers: cors('audio/wav') });
  }

  if (kind === 'stt') {
    // payload: { b64, name } — short voice-command audio, base64-encoded.
    const p = payload as { b64?: string; name?: string };
    if (!p || !p.b64 || p.b64.length > 4_000_000) return json({ error: 'bad-audio' }, 400);
    const bytes = Uint8Array.from(atob(p.b64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append('model', 'whisper-large-v3-turbo');
    form.append('file', new Blob([bytes]), p.name || 'voice.webm');
    const r = await fetch(GROQ + '/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form
    });
    return new Response(await r.text(), { status: r.status, headers: cors('application/json') });
  }

  return json({ error: 'unknown-kind' }, 400);
});

function cors(type?: string): HeadersInit {
  const h: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type'
  };
  if (type) h['Content-Type'] = type;
  return h;
}
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: cors('application/json') });
}
