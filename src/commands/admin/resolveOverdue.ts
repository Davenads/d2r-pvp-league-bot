import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { assertModRole } from '../../utils/modGuard.js';
import { resolveMatchByReadyCheck } from '../../services/readyCheck.js';

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Manual, on-demand version of the hourly ready-check deadline job (scheduler Job 5).
 * Finds every PENDING match past its 3-day deadline and runs the same
 * resolveMatchByReadyCheck() resolver on each — so a mod can clear stuck matches
 * immediately instead of waiting for the next scheduled sweep (useful when the
 * dyno has been cycling and the scheduled job hasn't had a chance to run).
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-resolve-overdue')
    .setDescription('Resolve all PENDING matches past their deadline by ready check (mod only)'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    try {
      const now = Date.now();

      // Deadline: base = reportedAt + 3d; post-extension = extendedAt + 3d.
      const pending = await prisma.match.findMany({
        where: { status: 'PENDING' },
        select: { id: true, reportedAt: true, extendedAt: true },
      });

      const overdue = pending.filter(
        (m) => (m.extendedAt ?? m.reportedAt).getTime() + THREE_DAYS_MS <= now,
      );

      if (overdue.length === 0) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle(`${CAIN_EMOJI} Overdue Match Sweep`)
              .setDescription('No PENDING matches are past their deadline. Nothing to resolve.')
              .setTimestamp(),
          ],
        });
        return;
      }

      // Snapshot pre-resolution extension state so outcomes can be classified after.
      const wasExtended = new Map<number, boolean>(
        overdue.map((m) => [m.id, m.extendedAt !== null]),
      );

      // Resolve each via the same resolver the hourly scheduler uses (non-throwing).
      for (const m of overdue) {
        await resolveMatchByReadyCheck(interaction.client, m.id);
      }

      // Re-fetch to classify final outcomes.
      const ids = overdue.map((m) => m.id);
      const after = await prisma.match.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, extendedAt: true },
      });

      const resolved: number[] = [];
      const extended: number[] = [];
      const deadlocked: number[] = [];
      const unchanged: number[] = [];

      for (const m of after) {
        if (m.status === 'CONFIRMED') resolved.push(m.id);
        else if (m.status === 'DISPUTED') deadlocked.push(m.id);
        else if (m.status === 'PENDING' && m.extendedAt !== null && !wasExtended.get(m.id)) extended.push(m.id);
        else unchanged.push(m.id);
      }

      const fmt = (arr: number[]): string => {
        if (!arr.length) return '—';
        const shown = arr.slice(0, 40).map((id) => `#${id}`).join(', ');
        return arr.length > 40 ? `${shown}, +${arr.length - 40} more` : shown;
      };

      const embed = new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`${CAIN_EMOJI} Overdue Match Sweep`)
        .setDescription(`Processed **${overdue.length}** overdue match(es).`)
        .addFields(
          { name: `Resolved by ready check (${resolved.length})`, value: fmt(resolved), inline: false },
          { name: `Auto-extended +3 days (${extended.length})`, value: fmt(extended), inline: false },
          { name: `Deadlocked — needs mod (${deadlocked.length})`, value: fmt(deadlocked), inline: false },
        );

      if (unchanged.length) {
        embed.addFields({ name: `Unchanged (${unchanged.length})`, value: fmt(unchanged), inline: false });
      }

      embed.setFooter({ text: `Swept by ${interaction.user.username}` }).setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[/admin-resolve-overdue]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Sweep failed. Check server logs.')] });
    }
  },
};
