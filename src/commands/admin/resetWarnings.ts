import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, CAIN_EMOJI } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { CHANNELS } from '../../config/channels.js';
import { assertModRole } from '../../utils/modGuard.js';
import { logActivity } from '../../utils/activityLogger.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-reset-warnings')
    .setDescription('Reset warnings for one player, or everyone (mod only)')
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('Player to reset. Omit to reset warnings for ALL players (requires confirm).')
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const target = interaction.options.getUser('player') ?? null;

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      // ── Single-player path — clear ALL of one player's warnings, no confirm ──
      if (target) {
        const player = await prisma.player.findFirst({
          where: { discordId: target.id, seasonId: season.id },
        });

        if (!player) {
          await interaction.editReply({
            embeds: [buildErrorEmbed(`**${target.username}** is not registered in **${season.name}**.`)],
          });
          return;
        }

        if (player.warnings === 0) {
          await interaction.editReply({
            embeds: [buildErrorEmbed(`**${target.username}** has no active warnings to clear.`)],
          });
          return;
        }

        const clearedCount = player.warnings;

        // Mark every uncleared audit record cleared + zero the counter, in sync.
        await prisma.$transaction([
          prisma.warning.updateMany({
            where: { playerId: player.id, clearedAt: null },
            data: { clearedAt: new Date(), clearedBy: interaction.user.id },
          }),
          prisma.player.update({
            where: { id: player.id },
            data: { warnings: 0 },
          }),
        ]);

        const embed = new EmbedBuilder()
          .setColor(Colors.Green)
          .setTitle(`${CAIN_EMOJI} Warnings Reset`)
          .setDescription(`All warnings for <@${target.id}> have been cleared.`)
          .addFields(
            { name: 'Warnings Cleared', value: String(clearedCount), inline: true },
            { name: 'Remaining Warnings', value: '0', inline: true },
          )
          .setFooter({ text: `Reset by ${interaction.user.username}` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
        if (logChannel) await logChannel.send({ embeds: [embed] });
        return;
      }

      // ── Global path — reset EVERYONE's warnings, red confirm button ──
      const warnedPlayerCount = await prisma.player.count({ where: { warnings: { gt: 0 } } });

      if (warnedPlayerCount === 0) {
        await interaction.editReply({
          embeds: [buildErrorEmbed('No players currently have warnings. Nothing to reset.')],
        });
        return;
      }

      const confirmEmbed = new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle(`${CAIN_EMOJI} Reset ALL Warnings — Confirm`)
        .setDescription(
          `You are about to clear warnings for **every** player in **${season.name}**.\n` +
          `This cannot be undone.`
        )
        .addFields({ name: 'Players Affected', value: `${warnedPlayerCount}`, inline: true })
        .setFooter({ text: 'Expires in 5 minutes. Only you can confirm this action.' });

      const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('reset_warnings_confirm')
          .setLabel('Reset All Warnings')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('reset_warnings_cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.editReply({ embeds: [confirmEmbed], components: [actionRow] });
      const reply = await interaction.fetchReply();

      let btn;
      try {
        btn = await reply.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i) => i.user.id === interaction.user.id,
          time: 5 * 60 * 1000,
        });
      } catch {
        await interaction.editReply({ components: [] }).catch(() => undefined);
        return;
      }

      if (btn.customId === 'reset_warnings_cancel') {
        await btn.deferUpdate();
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.DarkGrey)
              .setTitle(`${CAIN_EMOJI} Cancelled`)
              .setDescription('No warnings were reset.')
              .setTimestamp(),
          ],
          components: [],
        });
        return;
      }

      await btn.deferUpdate();

      // Re-count at execution time in case state changed during the confirm window.
      const clearedPlayers = await prisma.player.count({ where: { warnings: { gt: 0 } } });
      await prisma.warning.updateMany({
        where: { clearedAt: null },
        data: { clearedAt: new Date(), clearedBy: interaction.user.id },
      });
      await prisma.player.updateMany({ data: { warnings: 0 } });

      const doneEmbed = new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(`${CAIN_EMOJI} All Warnings Reset`)
        .setDescription(`Warnings have been cleared for every player in **${season.name}**.`)
        .addFields({ name: 'Players Cleared', value: String(clearedPlayers), inline: true })
        .setFooter({ text: `Reset by ${interaction.user.username}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [doneEmbed], components: [] });

      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) await logChannel.send({ embeds: [doneEmbed] });

      void logActivity(btn.client, {
        type: 'button',
        action: 'reset_warnings_confirm',
        label: 'All Warnings Reset',
        user: { id: btn.user.id, username: btn.user.username, displayName: btn.user.displayName },
        context: `${clearedPlayers} player(s) cleared`,
        channelId: btn.channelId,
        guildId: btn.guildId,
        timestamp: btn.createdAt,
      });
    } catch (err) {
      console.error('[/admin-reset-warnings]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
