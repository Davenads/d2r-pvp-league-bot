import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { CHANNELS } from '../../config/channels.js';
import { updatePlayerLadderStatus } from '../../services/ladder.js';
import { clearForcedMatch } from '../../services/queue.js';
import { archiveForcedThread } from '../../utils/forcedThread.js';
import { assertModRole } from '../../utils/modGuard.js';

const MAX_VACATION_DAYS = 60;

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-vacation')
    .setDescription('Grant or end a player vacation (mod only)')
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The player to place on / take off vacation')
        .setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('days')
        .setDescription(`Vacation length in days (1-${MAX_VACATION_DAYS}). Use 0 to end a vacation early.`)
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(MAX_VACATION_DAYS)
    )
    .addStringOption((opt) =>
      opt
        .setName('reason')
        .setDescription('Reason (optional)')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const target = interaction.options.getUser('player', true);
    const days = interaction.options.getInteger('days', true);
    const reason = interaction.options.getString('reason') ?? null;

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      const player = await prisma.player.findFirst({
        where: { discordId: target.id, seasonId: season.id },
      });

      if (!player) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${target.username}** is not registered in **${season.name}**.`)],
        });
        return;
      }

      if (player.status === 'REMOVED') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${target.username}** has been removed from the ladder. Re-register them with \`/admin-register\` before granting a vacation.`)],
        });
        return;
      }

      // ── End a vacation early ────────────────────────────────────────────
      if (days === 0) {
        if (player.status !== 'VACATION') {
          await interaction.editReply({
            embeds: [buildErrorEmbed(`**${target.username}** is not currently on vacation.`)],
          });
          return;
        }

        // Set hiatusUntil to now (expired) so the player is active again but
        // still gets the scheduler's post-vacation cadence grace before any
        // forced assignment fires.
        await prisma.player.update({
          where: { id: player.id },
          data: { status: 'ACTIVE', hiatusUntil: new Date() },
        });

        try {
          await updatePlayerLadderStatus(target.id, 'Available');
        } catch (sheetErr) {
          console.warn(`[/admin-vacation] Failed to sync 'Available' status to sheet for ${target.id}:`, sheetErr);
        }

        const endEmbed = new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`${CAIN_EMOJI} Vacation Ended`)
          .setDescription(`<@${target.id}> is now **active** on the ladder again.`)
          .addFields(...(reason ? [{ name: 'Reason', value: reason, inline: false }] : []))
          .setFooter({ text: `Ended by ${interaction.user.username}` })
          .setTimestamp();

        await interaction.editReply({ embeds: [endEmbed] });

        const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
        if (logChannel) await logChannel.send({ embeds: [endEmbed] });
        return;
      }

      // ── Grant a vacation ────────────────────────────────────────────────
      const hiatusUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

      await prisma.player.update({
        where: { id: player.id },
        data: { status: 'VACATION', hiatusUntil },
      });

      // Clear any forced assignment + notification thread so the warning
      // escalation job won't fire while the player is on vacation.
      await clearForcedMatch(target.id);
      await archiveForcedThread(
        interaction.client,
        target.id,
        '🏖️ Forced assignment closed — a moderator placed this player on vacation.',
      );

      // Mirror status to the Ladder sheet so they drop off the public board.
      try {
        await updatePlayerLadderStatus(target.id, 'Vacation');
      } catch (sheetErr) {
        console.warn(`[/admin-vacation] Failed to sync 'Vacation' status to sheet for ${target.id}:`, sheetErr);
      }

      const untilSec = Math.floor(hiatusUntil.getTime() / 1000);

      const grantEmbed = new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle(`${CAIN_EMOJI} Vacation Granted`)
        .setDescription(`<@${target.id}> is on vacation for **${days}** day${days === 1 ? '' : 's'} — until <t:${untilSec}:F> (<t:${untilSec}:R>).`)
        .addFields(...(reason ? [{ name: 'Reason', value: reason, inline: false }] : []))
        .setFooter({ text: `Granted by ${interaction.user.username}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [grantEmbed] });

      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) await logChannel.send({ embeds: [grantEmbed] });

      // Notify the player in #1v1-match-results
      const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
      if (resultsChannel) {
        await resultsChannel.send({
          content: `<@${target.id}>`,
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Blue)
              .setTitle('You Are On Vacation')
              .setDescription(
                `<@${target.id}>, a moderator has placed you on vacation until <t:${untilSec}:F> (<t:${untilSec}:R>). ` +
                'You will not receive forced-match assignments or warnings during this time.'
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/admin-vacation]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
