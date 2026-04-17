import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import type { Command } from '../../types/index.js';
import { cacheFlushPattern } from '../../services/cache.js';
import { updateLeaderboardEmbed } from '../../services/leaderboardEmbed.js';
import { EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('refresh-ladder')
    .setDescription('Clear ladder cache and immediately update the leaderboard embed (mod only)'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    try {
      // Clear the cached ladder entries so the next read hits Sheets fresh
      const deleted = await cacheFlushPattern('d2r:ladder*');

      // Immediately push a fresh embed to #1v1-leaderboard
      await updateLeaderboardEmbed(interaction.client);

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.success)
            .setTitle(`${CAIN_EMOJI} Ladder Refreshed`)
            .setDescription(
              `Cleared **${deleted}** cached ladder key(s) and pushed a fresh standings embed to <#${interaction.channelId}>.\n\n` +
              `The leaderboard channel has been updated.`
            ),
        ],
      });
    } catch (err) {
      console.error('[/refresh-ladder]', err);
      await interaction.editReply({ content: 'Failed to refresh ladder. Check logs.' });
    }
  },
};
