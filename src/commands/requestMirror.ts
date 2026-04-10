import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../utils/formatters.js';
import { getBuildChoices, resolveBuild } from '../utils/buildList.js';
import { prisma } from '../db/client.js';
import { getPlayerState, createMirrorRequest } from '../services/queue.js';
import { CHANNELS } from '../config/channels.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('request-mirror')
    .setDescription('Request a mirror match against another player (both must consent)')
    .addUserOption((opt) =>
      opt
        .setName('opponent')
        .setDescription('The player you want to mirror match')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build')
        .setDescription('The build both players will use')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused();
    await interaction.respond(getBuildChoices(focused));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const opponent = interaction.options.getUser('opponent', true);
    const rawBuild = interaction.options.getString('build', true);
    const requesterId = interaction.user.id;

    if (opponent.id === requesterId) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You can't request a mirror match against yourself.")] });
      return;
    }

    if (opponent.bot) {
      await interaction.editReply({ embeds: [buildErrorEmbed("You can't request a mirror match against a bot.")] });
      return;
    }

    const build = resolveBuild(rawBuild);
    if (!build) {
      await interaction.editReply({ embeds: [buildErrorEmbed(`Unknown build: **${rawBuild}**. Use the autocomplete list.`)] });
      return;
    }

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      // Validate both players are registered and active
      const [requesterPlayer, opponentPlayer] = await Promise.all([
        prisma.player.findFirst({ where: { discordId: requesterId, seasonId: season.id } }),
        prisma.player.findFirst({ where: { discordId: opponent.id, seasonId: season.id } }),
      ]);

      if (!requesterPlayer || requesterPlayer.status !== 'ACTIVE') {
        await interaction.editReply({ embeds: [buildErrorEmbed("You aren't registered and active in the current season.")] });
        return;
      }

      if (!opponentPlayer || opponentPlayer.status !== 'ACTIVE') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${opponent.username}** is not registered or active in the current season.`)],
        });
        return;
      }

      // Validate BOTH players have the requested build registered
      const requesterBuilds = [requesterPlayer.build1, requesterPlayer.build2, requesterPlayer.build3, requesterPlayer.build4, requesterPlayer.build5]
        .filter((b): b is string => !!b);
      const opponentBuilds = [opponentPlayer.build1, opponentPlayer.build2, opponentPlayer.build3, opponentPlayer.build4, opponentPlayer.build5]
        .filter((b): b is string => !!b);

      const requesterHasBuild = requesterBuilds.includes(build);
      const opponentHasBuild = opponentBuilds.includes(build);

      if (!requesterHasBuild) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `You don't have **${build}** registered.\n` +
            `Your builds: **${requesterBuilds.join(' / ')}**`
          )],
        });
        return;
      }

      if (!opponentHasBuild) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `**${opponent.username}** doesn't have **${build}** registered.\n` +
            `Their builds: **${opponentBuilds.join(' / ')}**`
          )],
        });
        return;
      }

      // Check neither player is already queued or in a match
      const [requesterState, opponentState] = await Promise.all([
        getPlayerState(requesterId),
        getPlayerState(opponent.id),
      ]);

      if (requesterState !== 'idle') {
        await interaction.editReply({ embeds: [buildErrorEmbed(`You're currently **${requesterState.replace('_', ' ')}**. Finish or leave your current activity first.`)] });
        return;
      }

      if (opponentState !== 'idle') {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`**${opponent.username}** is currently **${opponentState.replace('_', ' ')}** and can't accept a mirror request right now.`)],
        });
        return;
      }

      // Store the mirror request in Redis with TTL
      const nonce = await createMirrorRequest({
        requesterId,
        opponentId: opponent.id,
        build,
      });

      // Build the consent message
      const requestEmbed = new EmbedBuilder()
        .setColor(Colors.Blue)
        .setTitle('Mirror Match Request')
        .setDescription(
          `<@${requesterId}> has challenged <@${opponent.id}> to a mirror match!\n\n` +
          `**Build:** ${build} vs ${build}\n\n` +
          `<@${opponent.id}> — do you accept?`
        )
        .setFooter({ text: 'This request expires in 5 minutes.' });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`mirror_accept:${nonce}`)
          .setLabel('Accept')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`mirror_decline:${nonce}`)
          .setLabel('Decline')
          .setStyle(ButtonStyle.Danger),
      );

      // Post the consent request in #1v1-queue
      const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueChannel) {
        await queueChannel.send({
          content: `<@${opponent.id}>`,
          embeds: [requestEmbed],
          components: [row],
        });
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(EMBED_COLORS.info)
            .setTitle('Mirror Request Sent')
            .setDescription(
              `Your mirror match request has been sent to <@${opponent.id}> in <#${CHANNELS.queue}>.\n\n` +
              `**Build:** ${build}\n\nWaiting for their response (5 min timeout).`
            ),
        ],
      });
    } catch (err) {
      console.error('[/request-mirror]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Failed to send mirror request. Try again or contact a mod.')] });
    }
  },
};
