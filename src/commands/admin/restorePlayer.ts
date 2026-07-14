/**
 * /admin-restore-player
 *
 * Mod-only. Re-adds a previously removed player using their STORED builds and
 * preserves their existing W/L record — no matter how long ago they were removed.
 *
 * Unlike /admin-register (which requires builds to be re-typed and only carries
 * W/L over within a 24h grace window), this command reads the removed player's
 * builds straight from their existing Postgres record and reactivates their
 * Ladder sheet row in place, leaving all W/L/points columns untouched.
 *
 * Warnings are reset to 0 on restore.
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, buildRegistrationEmbed, CAIN_EMOJI } from '../../utils/formatters.js';
import { getClassEmoji } from '../../utils/classEmojis.js';
import { prisma } from '../../db/client.js';
import { CHANNELS } from '../../config/channels.js';
import { reactivatePlayerOnLadder } from '../../services/ladder.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-restore-player')
    .setDescription('Re-add a removed player with their old builds and W/L intact (mod only)')
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The removed Discord user to restore')
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const target = interaction.options.getUser('player', true);

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season. Open one with `/admin-season open` first.')] });
        return;
      }

      const player = await prisma.player.findUnique({
        where: { discordId: target.id },
      });

      if (!player) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${target.username}** has never been registered. Use \`/admin-register\` instead.`)],
        });
        return;
      }

      if (player.status !== 'REMOVED') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `**${target.username}** is not removed (current status: ${player.status}). Nothing to restore.`
          )],
        });
        return;
      }

      // Pull the player's stored builds — this is what makes restore "no typing".
      const builds = [player.build1, player.build2, player.build3, player.build4, player.build5]
        .filter((b): b is string => !!b);

      // Cross-season note: if the record is bound to a prior season, the live Ladder
      // sheet was cleared at season rollover, so reactivate falls back to a fresh row
      // (W/L can't be recovered once the sheet is wiped). Re-bind to the active season.
      const crossSeason = player.seasonId !== season.id;

      await prisma.player.update({
        where: { id: player.id },
        data: {
          seasonId: season.id,
          discordUsername: target.username,
          status: 'ACTIVE',
          warnings: 0,
          removedAt: null,
        },
      });

      // Reactivate the sheet row in place — preserves W/L/points, only flips
      // status back to Available and refreshes username/builds. No time gate.
      await reactivatePlayerOnLadder(target.id, target.username, builds);

      const buildList = builds
        .map((b) => { const e = getClassEmoji(b); return e ? `${e} ${b}` : b; })
        .join('\n');

      const confirmEmbed = new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(`${CAIN_EMOJI} Player Restored`)
        .setDescription(`<@${target.id}> has been restored to **${season.name}** with their previous builds and record intact.`)
        .addFields({ name: 'Restored Builds', value: buildList, inline: false })
        .setFooter({ text: `Restored by ${interaction.user.username}` })
        .setTimestamp();

      if (crossSeason) {
        confirmEmbed.addFields({
          name: 'Note',
          value: 'This player was removed in a prior season — builds were restored, but W/L could not be recovered (the ladder resets each season).',
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [confirmEmbed] });

      // Announce in the sign-up channel
      const signUpChannel = interaction.client.channels.cache.get(CHANNELS.signUpHere) as TextChannel | undefined;
      if (signUpChannel) {
        await signUpChannel.send({ embeds: [buildRegistrationEmbed(target.username, target.id, builds)] });
      }

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Green)
              .setTitle(`${CAIN_EMOJI} Admin: Player Restored`)
              .addFields(
                { name: 'Player', value: `<@${target.id}> (${target.username})`, inline: true },
                { name: 'Restored By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Season', value: season.name, inline: true },
                { name: 'W/L Preserved', value: crossSeason ? 'No (prior season)' : 'Yes', inline: true },
                { name: 'Restored Builds', value: buildList, inline: false },
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/admin-restore-player]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Restore failed. Check server logs.')] });
    }
  },
};
