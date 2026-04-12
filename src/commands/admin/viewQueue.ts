import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { EMBED_COLORS } from '../../utils/formatters.js';
import { getQueueList } from '../../services/queue.js';
import { prisma } from '../../db/client.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-view-queue')
    .setDescription('View the current match queue (mod only)'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    try {
      const queue = await getQueueList();

      if (queue.length === 0) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.info)
              .setTitle('Match Queue')
              .setDescription('The queue is currently empty.')
              .setTimestamp(),
          ],
        });
        return;
      }

      // Look up usernames for display
      const season = await prisma.season.findFirst({ where: { active: true } });

      const entries = await Promise.all(
        queue.map(async (discordId, i) => {
          let label = `<@${discordId}>`;
          if (season) {
            const player = await prisma.player.findFirst({
              where: { discordId, seasonId: season.id },
              select: { discordUsername: true, build1: true, build2: true, build3: true, build4: true, build5: true },
            });
            if (player) {
              const builds = [player.build1, player.build2, player.build3, player.build4, player.build5]
                .filter((b): b is string => !!b)
                .join(' / ');
              label = `**${player.discordUsername}** — ${builds}`;
            }
          }
          return `**${i + 1}.** ${label}`;
        })
      );

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.info)
            .setTitle(`Match Queue (${queue.length} player${queue.length !== 1 ? 's' : ''})`)
            .setDescription(entries.join('\n'))
            .setFooter({ text: 'Queue is FIFO — position 1 is next to be matched.' })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('[/admin-view-queue]', err);
      await interaction.editReply({ content: 'Failed to fetch queue. Check Redis connection.' });
    }
  },
};
