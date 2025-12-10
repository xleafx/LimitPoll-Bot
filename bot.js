const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');

// Initialize bot with your token
const bot = new Telegraf(process.env.BOT_TOKEN);

// Initialize SQLite database
const db = new Database('polls.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    message_id INTEGER,
    question TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    option_text TEXT NOT NULL,
    vote_limit INTEGER NOT NULL,
    FOREIGN KEY (poll_id) REFERENCES polls(id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    option_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT,
    voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (poll_id) REFERENCES polls(id),
    FOREIGN KEY (option_id) REFERENCES poll_options(id),
    UNIQUE(poll_id, user_id)
  );
`);

// Prepare statements for better performance
const statements = {
  createPoll: db.prepare('INSERT INTO polls (chat_id, question, created_by) VALUES (?, ?, ?)'),
  addOption: db.prepare('INSERT INTO poll_options (poll_id, option_text, vote_limit) VALUES (?, ?, ?)'),
  updateMessageId: db.prepare('UPDATE polls SET message_id = ? WHERE id = ?'),
  getPoll: db.prepare('SELECT * FROM polls WHERE id = ?'),
  getActivePoll: db.prepare('SELECT * FROM polls WHERE chat_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1'),
  getOptions: db.prepare('SELECT * FROM poll_options WHERE poll_id = ?'),
  getVoteCount: db.prepare('SELECT COUNT(*) as count FROM votes WHERE option_id = ?'),
  getUserVote: db.prepare('SELECT * FROM votes WHERE poll_id = ? AND user_id = ?'),
  addVote: db.prepare('INSERT INTO votes (poll_id, option_id, user_id, username) VALUES (?, ?, ?, ?)'),
  removeVote: db.prepare('DELETE FROM votes WHERE poll_id = ? AND user_id = ?'),
  getVoters: db.prepare('SELECT username FROM votes WHERE option_id = ?'),
  closePoll: db.prepare('UPDATE polls SET is_active = 0 WHERE id = ?')
};

// Store temporary poll creation data
const pollCreationState = new Map();

// Helper: Generate poll message and keyboard
function generatePollDisplay(pollId) {
  const poll = statements.getPoll.get(pollId);
  const options = statements.getOptions.all(pollId);
  
  let text = `📊 *${escapeMarkdown(poll.question)}*\n\n`;
  const buttons = [];

  options.forEach((option, index) => {
    const voteCount = statements.getVoteCount.get(option.id).count;
    const remaining = option.vote_limit - voteCount;
    const isFull = remaining <= 0;
    const voters = statements.getVoters.all(option.id);
    
    // Progress bar
    const filled = Math.round((voteCount / option.vote_limit) * 10);
    const progressBar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
    
    text += `${index + 1}. ${escapeMarkdown(option.option_text)}\n`;
    text += `   ${progressBar} ${voteCount}/${option.vote_limit}`;
    text += isFull ? ' ✅ FULL\n' : `\n`;
    
    if (voters.length > 0) {
      const voterNames = voters.map(v => v.username || 'Anonymous').join(', ');
      text += `   👥 ${escapeMarkdown(voterNames)}\n`;
    }
    text += '\n';

    // Button for this option
    const buttonText = isFull 
      ? `❌ ${option.option_text} (FULL)` 
      : `${option.option_text} (${remaining} left)`;
    
    buttons.push([Markup.button.callback(buttonText, `vote_${pollId}_${option.id}`)]);
  });

  if (poll.is_active) {
    buttons.push([Markup.button.callback('🔄 Retract my vote', `retract_${pollId}`)]);
  } else {
    text += '\n🔒 *This poll is closed*';
  }

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Command: /newpoll - Start creating a poll
bot.command('newpoll', (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  pollCreationState.set(userId, {
    chatId,
    step: 'question',
    question: null,
    options: []
  });

  ctx.reply(
    '📊 *Creating a new poll with vote limits*\n\n' +
    'Please send me the poll question:',
    { parse_mode: 'Markdown' }
  );
});

// Command: /done - Finish creating the poll
bot.command('done', (ctx) => {
  const userId = ctx.from.id;
  const state = pollCreationState.get(userId);

  if (!state || state.step !== 'options') {
    ctx.reply('No poll in progress. Use /newpoll to start.');
    return;
  }

  if (state.options.length < 2) {
    ctx.reply('⚠️ You need at least 2 options. Keep adding or /cancel to abort.');
    return;
  }

  // Create poll in database
  const result = statements.createPoll.run(state.chatId, state.question, userId);
  const pollId = result.lastInsertRowid;

  for (const option of state.options) {
    statements.addOption.run(pollId, option.text, option.limit);
  }

  // Generate and send poll
  const { text, keyboard } = generatePollDisplay(pollId);
  
  ctx.telegram.sendMessage(state.chatId, text, {
    parse_mode: 'Markdown',
    ...keyboard
  }).then((sentMessage) => {
    statements.updateMessageId.run(sentMessage.message_id, pollId);
  });

  pollCreationState.delete(userId);
  ctx.reply('✅ Poll created!');
});

// Command: /cancel - Cancel poll creation
bot.command('cancel', (ctx) => {
  pollCreationState.delete(ctx.from.id);
  ctx.reply('Poll creation cancelled.');
});

// Handle vote button clicks
bot.action(/^vote_(\d+)_(\d+)$/, (ctx) => {
  const pollId = parseInt(ctx.match[1]);
  const optionId = parseInt(ctx.match[2]);
  const userId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name;

  const poll = statements.getPoll.get(pollId);
  
  if (!poll || !poll.is_active) {
    ctx.answerCbQuery('This poll is closed.');
    return;
  }

  // Check if user already voted
  const existingVote = statements.getUserVote.get(pollId, userId);
  if (existingVote) {
    ctx.answerCbQuery('You already voted! Retract your vote first to change it.');
    return;
  }

  // Check if option is full
  const voteCount = statements.getVoteCount.get(optionId).count;
  const options = statements.getOptions.all(pollId);
  const option = options.find(o => o.id === optionId);

  if (voteCount >= option.vote_limit) {
    ctx.answerCbQuery('This option is full!');
    return;
  }

  // Add vote
  statements.addVote.run(pollId, optionId, userId, username);

  // Update message
  const { text, keyboard } = generatePollDisplay(pollId);
  ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...keyboard
  });

  ctx.answerCbQuery(`Voted for: ${option.option_text}`);
});

// Handle vote retraction
bot.action(/^retract_(\d+)$/, (ctx) => {
  const pollId = parseInt(ctx.match[1]);
  const userId = ctx.from.id;

  const existingVote = statements.getUserVote.get(pollId, userId);
  
  if (!existingVote) {
    ctx.answerCbQuery("You haven't voted yet!");
    return;
  }

  statements.removeVote.run(pollId, userId);

  const { text, keyboard } = generatePollDisplay(pollId);
  ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...keyboard
  });

  ctx.answerCbQuery('Vote retracted!');
});

// Handle poll creation messages
bot.on('text', (ctx) => {
  const userId = ctx.from.id;
  const state = pollCreationState.get(userId);

  if (!state) return;

  const text = ctx.message.text;

  // Ignore commands - let command handlers process them
  if (text.startsWith('/')) return;

  if (state.step === 'question') {
    state.question = text;
    state.step = 'options';
    
    ctx.reply(
      '✅ Question saved!\n\n' +
      'Now send me the poll options, one per message, in this format:\n' +
      '`Option text | limit`\n\n' +
      'Example: `Pizza | 5`\n\n' +
      'When done, send /done to create the poll.',
      { parse_mode: 'Markdown' }
    );
  } else if (state.step === 'options') {
    // Parse option format: "Option text | limit"
    const parts = text.split('|').map(p => p.trim());
    
    if (parts.length !== 2 || isNaN(parseInt(parts[1]))) {
      ctx.reply(
        '⚠️ Invalid format. Please use:\n`Option text | limit`\n\nExample: `Pizza | 5`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const optionText = parts[0];
    const limit = parseInt(parts[1]);

    if (limit < 1) {
      ctx.reply('⚠️ Limit must be at least 1');
      return;
    }

    state.options.push({ text: optionText, limit });
    
    ctx.reply(
      `✅ Added: "${optionText}" (limit: ${limit})\n\n` +
      `Options so far: ${state.options.length}\n\n` +
      'Send another option or /done to finish.'
    );
  }
});

// Command: /closepoll - Close the active poll
bot.command('closepoll', (ctx) => {
  const poll = statements.getActivePoll.get(ctx.chat.id);
  
  if (!poll) {
    ctx.reply('No active poll in this chat.');
    return;
  }

  if (poll.created_by !== ctx.from.id) {
    ctx.reply('Only the poll creator can close it.');
    return;
  }

  statements.closePoll.run(poll.id);

  const { text, keyboard } = generatePollDisplay(poll.id);
  
  if (poll.message_id) {
    ctx.telegram.editMessageText(ctx.chat.id, poll.message_id, null, text, {
      parse_mode: 'Markdown',
      ...keyboard
    });
  }

  ctx.reply('Poll closed!');
});

// Command: /help
bot.command(['start', 'help'], (ctx) => {
  ctx.reply(
    '🤖 *Poll Bot with Vote Limits*\n\n' +
    '*Commands:*\n' +
    '/newpoll - Create a new poll\n' +
    '/closepoll - Close the active poll\n' +
    '/cancel - Cancel poll creation\n' +
    '/help - Show this message\n\n' +
    '*How to create a poll:*\n' +
    '1. Send /newpoll\n' +
    '2. Enter your question\n' +
    '3. Add options in format: `Option | limit`\n' +
    '4. Send /done when finished',
    { parse_mode: 'Markdown' }
  );
});

// Start bot
bot.launch();
console.log('Bot is running...');

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));