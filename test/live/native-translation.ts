// Opt-in live check. Sends only synthetic text/images through the Codex subscription.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';

// Generated 64x64 solid red and blue PNGs; no external image fetches.
const red =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';
const blue =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ2oPcf88OIhvJ6vAAAAAElFTkSuQmCC';
const image = (data: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data },
});
const token = randomBytes(32).toString('hex');
const nonce = randomBytes(8).toString('hex');
const authFile = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  'auth.json',
);
const server = createNativeGateway({ token, authFile });
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address !== null && typeof address === 'object', 'Gateway port');
try {
  const format = {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        user_colour: { type: 'string' },
        tool_colour: { type: 'string' },
        nonce: { type: 'string' },
      },
      required: ['user_colour', 'tool_colour', 'nonce'],
      additionalProperties: false,
    },
  };
  for (const legacy of [false, true]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(180000),
      headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
      body: JSON.stringify({
        model: 'multi/openai/gpt-6-luna',
        stream: false,
        system:
          'Return the solid colour of each supplied image as a lowercase English word, and repeat the nonce exactly.',
        output_config: { effort: 'low', ...(!legacy ? { format } : {}) },
        ...(legacy ? { output_format: format } : {}),
        tools: [
          {
            name: 'Read',
            input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
          },
        ],
        tool_choice: { type: 'none' },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Nonce: ${nonce}. Here is the user image. Compare it with the image from Read.`,
              },
              image(red),
            ],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_fixture',
                name: 'Read',
                input: { file_path: 'synthetic.png' },
              },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: [image(blue)] }],
          },
        ],
      }),
    });
    const result: MessagesResponse = JSON.parse(await response.text());
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.stop_reason, 'end_turn');
    const answer = JSON.parse(
      result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
    );
    assert.deepEqual(answer, { user_colour: 'red', tool_colour: 'blue', nonce });
    console.log(
      `PASS: ${legacy ? 'legacy' : 'modern'} structured output + user/tool-result images on Luna.`,
    );
  }
  // A minimal valid PDF with a fresh nonce exercises actual document ingestion.
  const content = `BT /F1 18 Tf 72 720 Td (Document nonce: ${nonce}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const longName = `mcp__synthetic_document_test__${'long_tool_name_'.repeat(8)}`;
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    signal: AbortSignal.timeout(180000),
    headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
    body: JSON.stringify({
      model: 'multi/openai/gpt-6-luna',
      stream: false,
      system: 'Read the document and call the provided tool with its document nonce.',
      output_config: { effort: 'low' },
      tools: [
        {
          name: longName,
          input_schema: {
            type: 'object',
            properties: { nonce: { type: 'string' } },
            required: ['nonce'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: longName },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: Buffer.from(pdf).toString('base64'),
              },
            },
          ],
        },
      ],
    }),
  });
  const result: MessagesResponse = JSON.parse(await response.text());
  assert.equal(response.status, 200, JSON.stringify(result));
  const call = result.content.find((block) => block.type === 'tool_use');
  assert(call && call.name === longName, 'Restore the original MCP tool name');
  assert.deepEqual(call.input, { nonce });
  console.log('PASS: PDF input + long MCP name + named tool choice on Luna.');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
