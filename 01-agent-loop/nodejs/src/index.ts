import OpenAI from 'openai';
import * as readline from 'readline';
import { execSync } from 'child_process';

const client = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
  baseURL: process.env['OPENAI_API_BASE_URL'],
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));

const SYSTEM_PROMPT = `You are an AI assistant named xclaw. You can either respond with text or request a shell command to be executed.

You MUST always reply in one of these two exact formats:
- text: <your response>
- command: <bash command to execute>

Use "command:" when the user asks you to do something that requires running a shell command (e.g. list files, check git status, create a file).
Use "text:" for all other responses.
Never mix formats. Never include explanation outside the prefix.`;

const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: 'system', content: SYSTEM_PROMPT },
];

while (true) {
  const userInput = await ask('You: ');
  if (userInput.trim().toLowerCase() === 'exit') break;

  messages.push({ role: 'user', content: userInput });

  while (true) {
    const completion = await client.chat.completions.create({
      model: process.env['OPENAI_MODEL'] ?? 'GLM-5',
      messages,
    });

    const reply = completion.choices[0].message.content ?? '';
    messages.push({ role: 'assistant', content: reply });

    if (reply.startsWith('command: ')) {
      const cmd = reply.slice('command: '.length).trim();
      console.log(`xclaw runs: ${cmd}`);
      try {
        const output = execSync(cmd, { encoding: 'utf-8' });
        console.log(output);
        messages.push({ role: 'user', content: `command output:\n${output}` });
      } catch (err: any) {
        const errMsg = err.stderr ?? err.message;
        console.error(`error: ${errMsg}`);
        messages.push({ role: 'user', content: `command error:\n${errMsg}` });
      }
    } else if (reply.startsWith('text: ')) {
      console.log(`xclaw: ${reply.slice('text: '.length)}`);
      break;
    } else {
      console.log(`xclaw: ${reply}`);
      break;
    }
  }
}

rl.close();
