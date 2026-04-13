import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../utils/formatters.js';

// ── Hardcoded FAQ entries ─────────────────────────────────────────────────────

interface FaqEntry {
  question: string;
  answer: string;
}

const FAQ_ENTRIES: FaqEntry[] = [
  {
    question: 'How do I join the league?',
    answer:
      '⚔️ Use `/register` and select your builds from the list.\n\n' +
      'You can register **2 to 5 builds** — choose builds you\'re comfortable playing, since the bot will randomly assign one of your builds per match.\n\n' +
      'Registration is open **all season** — you can join at any time.',
  },
  {
    question: 'How does the queue work?',
    answer:
      '🎲 Run `/queue` to enter the matchmaking queue.\n\n' +
      'The queue is **FIFO** (first in, first out). When two players are in queue at the same time, they are immediately matched. ' +
      'The bot **randomly selects** a valid build pairing from both players\' registered builds.\n\n' +
      '⚠️ Queue membership is **private** — you cannot see who else is in queue. This prevents opponent cherry-picking.',
  },
  {
    question: 'How are build matchups chosen?',
    answer:
      '🤖 The bot does it automatically — **you don\'t choose**.\n\n' +
      'When two players are matched, the bot computes all possible build pairings and removes any that are banned. ' +
      'It then **randomly picks one** of the remaining valid pairings. Neither player has input on this.\n\n' +
      'If every possible pairing is banned, the bot will prompt both players with the option to override (play anyway) or re-queue.',
  },
  {
    question: 'What is a Deathmatch (FT2)?',
    answer:
      '💀 A **Deathmatch** is a match type where certain build pairings are inherently more one-sided, so the format is shortened to **First to 2 wins** instead of the standard FT4.\n\n' +
      'The bot automatically detects deathmatch pairings based on the Deathmatches tab in the league sheet. If your assigned pairing is a deathmatch, the match thread will clearly label it as **DEATHMATCH (FT2)**.\n\n' +
      'Use `/deathmatch build:<your build>` to see which matchups are considered deathmatches for a given build.',
  },
  {
    question: 'What is the Test Rule?',
    answer:
      '🧪 The **Test Rule** is an experimental ruleset that can apply to certain matchups. These matches are tracked separately from regular W/L stats.\n\n' +
      'When reporting a win for a test rule match, use `/report-win opponent:@player test_rule:True`.\n\n' +
      '**Note:** If your match was assigned as a Deathmatch, the test rule flag is ignored — it only applies to Standard matches.',
  },
  {
    question: 'How do I report a match result?',
    answer:
      '🏆 The **winner** uses `/report-win opponent:@loser` after the match is complete.\n\n' +
      'Results are recorded immediately — no confirmation from your opponent is required. ' +
      'The result will be posted in `#1v1-match-results` and your stats in the Ladder sheet will update automatically.\n\n' +
      'If there is a dispute, contact a **1v1 Moderator** directly — do not re-report.',
  },
  {
    question: 'How does ranking and the points system work?',
    answer:
      '📊 Rankings are determined by **hidden points** (primary), then **W/L%** (tiebreaker), then **total wins** (second tiebreaker).\n\n' +
      'Points are awarded as follows:\n' +
      '• **Standard match (FT4):** Win = +1 pt\n' +
      '• **Deathmatch (FT2):** Win = +1 pt\n' +
      '• **Test Rule match:** Win = +1 pt (tracked separately)\n' +
      '• **Tournament match:** Win = +3 pts, Loss = +1 pt\n\n' +
      '⚠️ Points and W/L stats are **not publicly displayed** on `/ladder`. Only your rank and name are shown — this keeps competition focused on playing, not scoreboard anxiety.',
  },
  {
    question: 'What happens if I don\'t play regularly?',
    answer:
      '⏰ Players are expected to play approximately every **3 days**.\n\n' +
      'If you haven\'t played within that window, the bot will ping you with a **Forced Match Assignment** in `#1v1-queue`. ' +
      'You must use `/im-ready` to acknowledge and re-enter the queue within **24 hours**.\n\n' +
      'Failure to respond will result in a **warning**. Accumulating **5 warnings** triggers automatic removal from the ladder. ' +
      'Mods can manually issue or clear warnings if needed.',
  },
  {
    question: 'What are banned matchups?',
    answer:
      '🚫 Some build vs build pairings are **banned** from the league and cannot be played.\n\n' +
      'Use `/banned-matchups` to see the full banned list, or `/banned-matchups build:<build>` to filter by your build.\n\n' +
      'If you are matched and all valid pairings are banned, the bot will notify both players in the match thread with override/re-queue options.',
  },
  {
    question: 'Can I request a mirror match?',
    answer:
      '🪞 Yes — mirror matches are allowed with **mutual consent**.\n\n' +
      'After you\'ve been matched with an opponent, use `/request-mirror opponent:@player build:<build>` to propose a mirror. ' +
      'Your opponent will receive a prompt in `#1v1-queue` with Accept/Decline buttons. ' +
      'Both players must agree — if declined, the bot-assigned pairing stands.',
  },
  {
    question: 'How do I look up matchup rules?',
    answer:
      '📖 Use `/matchup build_a:<your build> build_b:<opponent build>`.\n\n' +
      'This shows the rules for both sides of the matchup as defined by the league. The lookup is **symmetric** — `/matchup Ghost Trapper` and `/matchup Trapper Ghost` return the same result.\n\n' +
      'Check `/banned-matchups` first if you\'re unsure whether a pairing is legal.',
  },
  {
    question: 'Can I register more than one build?',
    answer:
      '✅ Yes — you can register **2 to 5 builds** when you sign up.\n\n' +
      'During matchmaking, the bot selects from both players\' registered builds to find a valid (non-banned) pairing. ' +
      'More builds = more possible pairings = less chance of hitting an all-banned situation.\n\n' +
      'Your builds cannot be changed after registration. Contact a mod if you need an adjustment.',
  },
];

// ── Command ───────────────────────────────────────────────────────────────────

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('faq')
    .setDescription('Look up a D2R 1v1 League FAQ entry')
    .addStringOption((opt) =>
      opt
        .setName('topic')
        .setDescription('Select a question (leave blank to list all)')
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const partial = interaction.options.getFocused().toLowerCase();
    const matches = FAQ_ENTRIES
      .filter((e) => e.question.toLowerCase().includes(partial))
      .slice(0, 25)
      .map((e) => ({
        name: e.question.length > 100 ? `${e.question.slice(0, 97)}...` : e.question,
        value: e.question,
      }));
    await interaction.respond(matches);
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const topic = interaction.options.getString('topic');

    // No topic → list all questions
    if (!topic) {
      const lines = FAQ_ENTRIES.map((e, i) => `**${i + 1}.** ${e.question}`).join('\n');

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.info)
            .setTitle('⚔️ D2R 1v1 League — Frequently Asked Questions')
            .setDescription(lines)
            .setFooter({ text: 'Use /faq topic:<question> to see the full answer.' }),
        ],
      });
      return;
    }

    // Search — exact first, then partial
    const lower = topic.toLowerCase();
    const match =
      FAQ_ENTRIES.find((e) => e.question.toLowerCase() === lower) ??
      FAQ_ENTRIES.find((e) => e.question.toLowerCase().includes(lower));

    if (!match) {
      await interaction.editReply({
        embeds: [
          buildErrorEmbed(
            `No FAQ entry found for: **${topic}**\n\nUse \`/faq\` without a topic to browse all questions.`
          ),
        ],
      });
      return;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(EMBED_COLORS.info)
          .setTitle(match.question)
          .setDescription(match.answer)
          .setFooter({ text: 'D2R 1v1 League FAQ' }),
      ],
    });
  },
};
