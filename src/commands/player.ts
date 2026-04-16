import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../utils/formatters.js';
import { prisma } from '../db/client.js';

/** Returns win/loss/pct string, e.g. "5W / 3L (62.5%)" */
function wlString(wins: number, losses: number): string {
  const total = wins + losses;
  const pct = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
  return `${wins}W / ${losses}L (${pct}%)`;
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('player')
    .setDescription("Look up a player's stats and record")
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The player to look up (defaults to yourself)')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    // Default to the command user if no target provided
    const target = interaction.options.getUser('player') ?? interaction.user;

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({
          embeds: [buildErrorEmbed('No active season.')],
        });
        return;
      }

      const player = await prisma.player.findFirst({
        where: { discordId: target.id, seasonId: season.id },
      });

      if (!player) {
        const isSelf = target.id === interaction.user.id;
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            isSelf
              ? "You aren't registered for this season. Use `/register` to join."
              : `**${target.username}** is not registered in **${season.name}**.`
          )],
        });
        return;
      }

      // Tally match stats from Postgres
      const [standardMatches, trMatches, dmMatches] = await Promise.all([
        prisma.match.findMany({
          where: {
            status: 'CONFIRMED',
            type: 'STANDARD',
            OR: [{ player1Id: player.id }, { player2Id: player.id }],
          },
          select: { winnerId: true },
        }),
        prisma.match.findMany({
          where: {
            status: 'CONFIRMED',
            type: 'TEST_RULE',
            OR: [{ player1Id: player.id }, { player2Id: player.id }],
          },
          select: { winnerId: true },
        }),
        prisma.match.findMany({
          where: {
            status: 'CONFIRMED',
            type: 'DEATHMATCH',
            OR: [{ player1Id: player.id }, { player2Id: player.id }],
          },
          select: { winnerId: true },
        }),
      ]);

      const countWL = (matches: { winnerId: number | null }[]) => {
        const wins = matches.filter((m) => m.winnerId === player.id).length;
        return { wins, losses: matches.length - wins };
      };

      const std = countWL(standardMatches);
      const tr = countWL(trMatches);
      const dm = countWL(dmMatches);

      // Status display
      const statusEmoji: Record<string, string> = {
        ACTIVE: '🟢',
        VACATION: '🌴',
        REMOVED: '🔴',
      };
      const statusLabel: Record<string, string> = {
        ACTIVE: 'Active',
        VACATION: 'Vacation',
        REMOVED: 'Removed',
      };

      const embed = new EmbedBuilder()
        .setColor(player.status === 'REMOVED' ? Colors.Red : Colors.Gold)
        .setTitle(`${CAIN_EMOJI} ${target.username} — ${season.name}`)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          {
            name: 'Registered Builds',
            value: [player.build1, player.build2, player.build3, player.build4, player.build5]
              .filter((b): b is string => !!b)
              .join(' / '),
            inline: false,
          },
          { name: 'Status', value: `${statusEmoji[player.status] ?? ''} ${statusLabel[player.status] ?? player.status}`, inline: true },
          { name: 'Standard Record', value: wlString(std.wins, std.losses), inline: true },
          { name: 'Test Rule Record', value: wlString(tr.wins, tr.losses), inline: true },
          { name: 'Deathmatch Record', value: wlString(dm.wins, dm.losses), inline: true },
          { name: 'Warnings', value: `${player.warnings}`, inline: true },
          { name: 'Registered', value: `<t:${Math.floor(player.registeredAt.getTime() / 1000)}:D>`, inline: true },
          {
            name: 'Last Match',
            value: player.lastMatchAt
              ? `<t:${Math.floor(player.lastMatchAt.getTime() / 1000)}:R>`
              : '*No matches yet*',
            inline: true,
          },
        )
        .setFooter({ text: `Season: ${season.name}` });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[/player]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Failed to fetch player data. Try again later.') ]});
    }
  },
};
