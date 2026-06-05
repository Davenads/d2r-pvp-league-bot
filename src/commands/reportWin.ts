import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed } from '../utils/formatters.js';
import { prisma } from '../db/client.js';
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
      // Find the PENDING match between the reporter and the declared winner
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      const match = await prisma.match.findFirst({
        where: {
          seasonId: season.id,
          status: 'PENDING',
          OR: [
            {
              player1: { discordId: reporterDiscordId },
              player2: { discordId: winner.id },
            },
            {
              player2: { discordId: reporterDiscordId },
              player1: { discordId: winner.id },
            },
          ],
        },
        include: { player1: true, player2: true },
      });

      if (!match) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`No active match found between you and <@${winner.id}>. Check that you named the correct opponent.`)],
        });
        return;
      }

      const result = await processMatchResult(
        interaction.client,
        match.id,
        winner.id,
        reporterDiscordId,
        isTestRule,
        match.threadId,
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
