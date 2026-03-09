const NEWS_MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 12;
const CONFIDENCE_THRESHOLD = 0.6;
const MAX_MESSAGES = 3;

async function runProactiveNews(client, topics, memory, personality, timezone, selfMemory) {
  const log = process.env.OBOL_VERBOSE ? (msg) => console.log(`[news] ${msg}`) : () => {};
  const composed = [];

  const localTime = new Date().toLocaleString('en-US', {
    timeZone: timezone || 'UTC',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const systemParts = [
    `You're looking up news for a friend. Not a user, not a subscriber — a friend you actually know.`,
    `Their topics of interest: ${topics.join(', ')}`,
    `Local time: ${localTime} (${timezone || 'UTC'})`,
    ``,
    `Search the web for recent news on their topics. Then check your memory of them to find personal connections — things they've mentioned, projects they're working on, opinions they've shared.`,
    ``,
    `Rules:`,
    `- Max ${MAX_MESSAGES} messages. Quality over quantity — send 0 if nothing is worth sharing`,
    `- Only compose a message if you found something genuinely interesting AND can connect it to something you know about them`,
    `- Friend-style, not newsletter. No bullet points, no "here's your daily digest"`,
    `- Short and punchy. Like texting a friend a link with a one-liner`,
    `- If you find nothing worth sharing, that's fine. Don't force it`,
  ];

  if (personality?.soul) systemParts.push(`\nYour personality:\n${personality.soul}`);
  if (personality?.user) systemParts.push(`\nWhat you know about them:\n${personality.user}`);

  const tools = [
    { type: 'web_search_20250305', name: 'web_search' },
    {
      name: 'search_user_memory',
      description: 'Search your memory of this person — their interests, projects, opinions, life events',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for in your memory of them' },
        },
        required: ['query'],
      },
    },
    {
      name: 'compose_news_message',
      description: 'Compose a message to send to your friend about something you found',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The message to send — casual, friend-style' },
          confidence: { type: 'number', description: 'How confident this is worth sending (0-1). Be honest — only high-confidence messages get sent' },
          topic: { type: 'string', description: 'Which topic this relates to' },
        },
        required: ['message', 'confidence', 'topic'],
      },
    },
  ];

  const messages = [{ role: 'user', content: 'Check the news and see if anything is worth sharing.' }];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    log(`Iteration ${i + 1}/${MAX_ITERATIONS}...`);

    const response = await client.messages.create({
      model: NEWS_MODEL,
      max_tokens: 2000,
      tools,
      system: systemParts.join('\n'),
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;
    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      if (block.name === 'search_user_memory') {
        log(`  Memory search: "${block.input.query}"`);
        try {
          const results = memory
            ? await memory.search(block.input.query, { limit: 5, threshold: 0.3 })
            : [];
          const text = results.length
            ? results.map(m => `- ${m.content}`).join('\n')
            : '(nothing found)';
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: text });
        } catch (e) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Search failed: ${e.message}` });
        }
      } else if (block.name === 'compose_news_message') {
        const { message, confidence, topic } = block.input;
        log(`  Compose [${topic}] confidence=${confidence}: ${message.substring(0, 100)}`);

        if (confidence >= CONFIDENCE_THRESHOLD && composed.length < MAX_MESSAGES) {
          composed.push(message);
          if (selfMemory) {
            selfMemory.add(message, {
              category: 'research',
              importance: Math.min(confidence, 0.8),
              tags: ['news', topic.toLowerCase()],
              source: 'news',
            }).catch(e => log(`Failed to store news in self-memory: ${e.message}`));
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Message queued for delivery' });
        } else if (composed.length >= MAX_MESSAGES) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Already have ${MAX_MESSAGES} messages queued. Done.` });
        } else {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Confidence too low (${confidence} < ${CONFIDENCE_THRESHOLD}). Skip this one.` });
        }
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }

    if (composed.length >= MAX_MESSAGES) break;
  }

  log(`Composed ${composed.length} messages`);
  return composed;
}

module.exports = { runProactiveNews };
