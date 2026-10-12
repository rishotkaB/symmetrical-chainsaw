// Вебхук навыка Яндекс Диалогов -> OpenAI -> ответ Алисы.
// Ограничение Алисы: ответ вебхука должен прийти за 3 секунды, поэтому
// держим короткий таймаут, быстрый модель и короткие ответы.

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = 2300; // с запасом до лимита Алисы в 3 с
const MAX_HISTORY = 6; // сколько последних реплик помним в рамках сессии

const SYSTEM_PROMPT =
  "Ты голосовой помощник на умной колонке. Отвечай по-русски, коротко: " +
  "1-3 предложения, без markdown, списков и эмодзи, так, чтобы это было " +
  "удобно слушать. Если вопрос неясен, задай один уточняющий вопрос.";

const EXIT_WORDS = ["хватит", "выход", "выйти", "стоп", "закончить", "до свидания"];

function reply(body, text, extra = {}) {
  const clean = text.slice(0, 900);
  return {
    version: body.version || "1.0",
    session: body.session,
    response: { text: clean, tts: clean, end_session: false },
    ...extra,
  };
}

async function askOpenAI(history) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OPENAI_TIMEOUT_MS);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
        max_completion_tokens: 200,
        temperature: 0.7,
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("ok");

  // Простая защита, чтобы чужие не жгли ваш баланс OpenAI
  if (process.env.ALICE_SECRET && req.query.key !== process.env.ALICE_SECRET) {
    return res.status(403).send("forbidden");
  }

  const body = req.body || {};
  const utterance = (body.request?.original_utterance || "").trim();
  const command = (body.request?.command || "").trim().toLowerCase();

  // Приветствие при запуске навыка
  if (body.session?.new && !command) {
    return res.json(reply(body, "Привет! Я на связи с ChatGPT. О чём поговорим?"));
  }

  if (EXIT_WORDS.some((w) => command.includes(w))) {
    const out = reply(body, "Хорошо, до связи!");
    out.response.end_session = true;
    return res.json(out);
  }

  if (!utterance) {
    return res.json(reply(body, "Я вас не расслышала. Повторите, пожалуйста."));
  }

  // История диалога хранится у Алисы (session_state), сервер остаётся stateless
  const prev = Array.isArray(body.state?.session?.history) ? body.state.session.history : [];
  const history = [...prev, { role: "user", content: utterance }].slice(-MAX_HISTORY);

  let answer;
  try {
    answer = await askOpenAI(history);
  } catch (e) {
    console.error("openai error:", e.message);
    return res.json(
      reply(body, "Не успела обдумать ответ. Спросите, пожалуйста, ещё раз, можно покороче.", {
        session_state: { history: prev },
      })
    );
  }

  if (!answer) answer = "Не нашла что ответить. Попробуйте переформулировать.";
  const newHistory = [...history, { role: "assistant", content: answer }].slice(-MAX_HISTORY);

  return res.json(reply(body, answer, { session_state: { history: newHistory } }));
}
