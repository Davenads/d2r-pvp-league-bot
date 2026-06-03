import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed } from '../utils/formatters.js';
import { prisma } from '../db/client.js';
import { getActiveMatch } from '../services/queue.js';
import { processMatchResult } from '../utils/matchResult.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('report-win')
    .setDescription('Report the result of your match — either player can report')
    .addUserOption((opt) =>
      opt
        .setName('winner')
        .setDescription('The player who won the match')
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('test_rule')
        .setDescription('Was this a standard match played under the test rule? (default: false)')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const winner = interaction.options.getUser('winner', true);
    const isTestRule = interaction.options.getBoolean('test_rule') ?? false;
    const reporterDiscordId = interaction.user.id;

    try {
      // Verify reporter is in an active match
      const activeMatch = await getActiveMatch(reporterDiscordId);
      if (!activeMatch) {
        await interaction.editReply({
          embeds: [buildErrorEmbed("You don't have an active match. Use `/queue` to find an opponent.")],
        });
        return;
      }

      // Verify the named winner is one of the two participants
      const { player1DiscordId, player2DiscordId, matchId } = activeMatch;
      if (winner.id !== player1DiscordId && winner.id !== player2DiscordId) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `<@${winner.id}> is not a participant in your active match.\n\nYour match is between <@${player1DiscordId}> and <@${player2DiscordId}>.`
          )],
        });
        return;
      }

      const result = await processMatchResult(
        interaction.client,
        matchId,
        winner.id,
        reporterDiscordId,
        isTestRule,
        activeMatch.threadId,
      );

      if (!result.success) {
        await interaction.editReply({ embeds: [buildErrorEmbed(result.errorMessage)] });
        return;
      }

      await interaction.editReply({ embeds: [result.embed] });

    } catch (err) {
      console.error('[/report-win]', err);
      await interaction.editReply({
        embeds: [buildErrorEmbed('Failed to record result. Try again or contact a mod.')],
      });
    }
  },
};
