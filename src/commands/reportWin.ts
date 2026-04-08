import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  ThreadChannel,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { prisma } from '../db/client.js';
import { getActiveMatch } from '../services/queue.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('report-win')
    .setDescription('Report a match result (winner initiates)')
    .addUserOption((opt) =>
      opt
        .setName('opponent')
        .setDescription('The player you defeated')
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('test_rule')
        .setDescription('Was this played under the test rule? (default: false)')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const opponent = interaction.options.getUser('opponent', true);
    const isTestRule = interaction.options.getBoolean('test_rule') ?? false;
    const reporterDiscordId = interaction.user.id;

    if (opponent.id === reporterDiscordId) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You can't report a win against yourself.")] });
      return;
    }

    try {
      // Verify reporter has an active match
      const activeMatch = await getActiveMatch(reporterDiscordId);
      if (!activeMatch) {
        await interaction.editReply({ embeds: [buildErrorEmbed("You don't have an active match. Use `/queue` to find an opponent.")] });
        return;
      }

      // Verify the specified opponent matches the active match
      const opponentId = activeMatch.player1DiscordId === reporterDiscordId
        ? activeMatch.player2DiscordId
        : activeMatch.player1DiscordId;

      if (opponent.id !== opponentId) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `Your active match is against <@${opponentId}>, not <@${opponent.id}>.\n\nIf this is wrong, contact a mod.`
          )],
        });
        return;
      }

      // Look up reporter in Postgres to get DB id
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      const reporterPlayer = await prisma.player.findFirst({
        where: { discordId: reporterDiscordId, seasonId: season.id },
      });
      if (!reporterPlayer) {
        await interaction.editReply({ embeds: [buildErrorEmbed('Could not find your player record.')] });
        return;
      }

      // Update the Match record: record winner + type
      const match = await prisma.match.findUnique({ where: { id: activeMatch.matchId } });
      if (!match) {
        await interaction.editReply({ embeds: [buildErrorEmbed('Match record not found. Contact a mod.')] });
        return;
      }

      if (match.status === 'CONFIRMED') {
        await interaction.editReply({ embeds: [buildErrorEmbed('This match result has already been confirmed.')] });
        return;
      }

      await prisma.match.update({
        where: { id: match.id },
        data: {
          winnerId: reporterPlayer.id,
          type: isTestRule ? 'TEST_RULE' : 'STANDARD',
          // status stays PENDING until opponent confirms
        },
      });

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Yellow)
            .setTitle('Result Reported')
            .setDescription(
              `You've reported a win against <@${opponent.id}>.\n\n` +
              `**Match type:** ${isTestRule ? 'Test Rule' : 'Standard'}\n\n` +
              `Waiting for <@${opponent.id}> to confirm.`
            )
            .setFooter({ text: 'The result is not final until your opponent confirms.' }),
        ],
      });

      // Post confirmation request in the match thread (if it exists)
      const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_result:${match.id}`)
          .setLabel('Confirm Win')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`dispute_result:${match.id}`)
          .setLabel('Dispute')
          .setStyle(ButtonStyle.Danger),
      );

      const threadEmbed = new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setTitle('Result Awaiting Confirmation')
        .setDescription(
          `<@${reporterDiscordId}> has reported a **${isTestRule ? 'Test Rule' : 'Standard'}** win.\n\n` +
          `<@${opponent.id}> — please confirm or dispute below.`
        )
        .setFooter({ text: `Match #${match.id}` });

      if (activeMatch.threadId) {
        try {
          const thread = interaction.client.channels.cache.get(activeMatch.threadId) as ThreadChannel | undefined;
          if (thread) {
            await thread.send({ embeds: [threadEmbed], components: [confirmRow] });
          }
        } catch (threadErr) {
          console.warn('[/report-win] Failed to post to match thread:', threadErr);
        }
      }
    } catch (err) {
      console.error('[/report-win]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Failed to report result. Try again or contact a mod.')] });
    }
  },
};
