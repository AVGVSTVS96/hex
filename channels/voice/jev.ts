import { z } from "zod";

export type Judge = (state: Record<string, string>, question: string) => Promise<number>;

const Answer = z.object({
  answers: z.object({ wants: z.object({ noul: z.number() }) }),
});

export function jev(key: string, model: string, url: string): Judge {
  return async (state, question) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        state,
        questions: { wants: { type: "noul", instructions: question } },
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      throw new Error(`Jev ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    return Answer.parse(await response.json()).answers.wants.noul;
  };
}
