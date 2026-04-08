import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { getForcedMatch, clearForcedMatch, getPlayerState, joinQueue } from '../services/queue.js';
import { CHANNELS } from '../config/channels.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('im-ready')
    .setDescription('Acknowledge a forced match assignment and enter the queue'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;

    try {
      // Check for a pending forced match assignment
      const forced = await getForcedMatch(discordId);

      if (!forced) {
        // No forced assignment — check if they just want to confirm they're available
        const state = await getPlayerState(discordId);
        if (state === 'in_match') {
          await interaction.editReply({
            embeds: [buildErrorEmbed("You're currently in an active match. Report the result first with `/report-win`.")],
          });
          return;
        }

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle('No Forced Match Pending')
              .setDescription(
                "You don't have a pending forced match assignment right now.\n\n" +
                "Use `/queue` to enter the normal match queue."
              ),
          ],
        });
        return;
      }

      // Clear the forced match flag
      await clearForcedMatch(discordId);

      // Enter the queue on their behalf (FIFO matching applies)
      const outcome = await joinQueue(discordId);

      if (!outcome.matched) {
        // Placed in queue
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle('Ready — Added to Queue')
              .setDescription(
                "You've acknowledged your forced match assignment and have been added to the queue.\n\n" +
                `**Queue position:** #${outcome.position}\n\n` +
                "You'll be notified when an opponent is found."
              ),
          ],
        });

        // Notify mods
        const modQueueChannel = interaction.client.channels.cache.get(CHANNELS.modQueue) as TextChannel | undefined;
        if (modQueueChannel) {
          await modQueueChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(Colors.Green)
                .setDescription(`<@${discordId}> acknowledged forced match and joined queue at position #${outcome.position}`)
                .setTimestamp(),
            ],
          });
        }
        return;
      }

      // Immediate match — same as normal queue flow
      const { matchId, opponentDiscordId, yourBuild, opponentBuild } = outcome;

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle('Ready — Match Found!')
            .setDescription(
              `You've been matched against <@${opponentDiscordId}>.\n\n` +
              `**Your build:** ${yourBuild}\n` +
              `**Opponent's build:** ${opponentBuild}\n\n` +
              'Check your match thread for the rules.'
            ),
        ],
      });

      const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueChannel) {
        await queueChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle('Forced Match Assigned')
              .addFields(
                { name: 'Player 1', value: `<@${discordId}> — ${yourBuild}`, inline: true },
                { name: 'Player 2', value: `<@${opponentDiscordId}> — ${opponentBuild}`, inline: true },
                { name: 'Match #', value: String(matchId), inline: true },
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/im-ready]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Try again or contact a mod.')] });
    }
  },
};
