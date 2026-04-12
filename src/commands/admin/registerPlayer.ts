import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { getBuildChoices, resolveBuild } from '../../utils/buildList.js';
import { buildErrorEmbed, buildRegistrationEmbed } from '../../utils/formatters.js';
import { getClassEmoji } from '../../utils/classEmojis.js';
import { prisma } from '../../db/client.js';
import { CHANNELS } from '../../config/channels.js';
import { addPlayerToLadder, reactivatePlayerOnLadder } from '../../services/ladder.js';
import { assertModRole } from '../../utils/modGuard.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-register')
    .setDescription('Register a player on their behalf (mod only)')
    .addUserOption((opt) =>
      opt
        .setName('player')
        .setDescription('The Discord user to register')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_1')
        .setDescription('First build (required)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_2')
        .setDescription('Second build (required)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_3')
        .setDescription('Third build (optional)')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_4')
        .setDescription('Fourth build (optional)')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('build_5')
        .setDescription('Fifth build (optional)')
        .setRequired(false)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    await interaction.respond(getBuildChoices(focused.value));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const target = interaction.options.getUser('player', true);

    const rawInputs = [
      interaction.options.getString('build_1', true),
      interaction.options.getString('build_2', true),
      interaction.options.getString('build_3', false),
      interaction.options.getString('build_4', false),
      interaction.options.getString('build_5', false),
    ].filter((v): v is string => v !== null && v.trim() !== '');

    const resolved: Array<string | null> = rawInputs.map((r) => resolveBuild(r) ?? null);

    for (let i = 0; i < rawInputs.length; i++) {
      if (resolved[i] === null) {
        await interaction.editReply({
          embeds: [buildErrorEmbed(`Unknown build: **${rawInputs[i]}**. Use the autocomplete list.`)],
        });
        return;
      }
    }

    const builds = resolved as string[];

    if (new Set(builds).size !== builds.length) {
      await interaction.editReply({
        embeds: [buildErrorEmbed('All registered builds must be different.')],
      });
      return;
    }

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season. Open one with `/admin-season open` first.')] });
        return;
      }

      const existing = await prisma.player.findFirst({
        where: { discordId: target.id, seasonId: season.id },
      });

      if (existing && existing.status !== 'REMOVED') {
        const existingBuilds = [existing.build1, existing.build2, existing.build3, existing.build4, existing.build5]
          .filter((b): b is string => !!b);
        const buildList = existingBuilds.map((b, i) => `• Build ${i + 1}: **${b}**`).join('\n');
        await interaction.editReply({
          embeds: [buildErrorEmbed(
            `**${target.username}** is already registered for **${season.name}**:\n${buildList}`
          )],
        });
        return;
      }

      if (existing && existing.status === 'REMOVED') {
        await prisma.player.update({
          where: { id: existing.id },
          data: {
            discordUsername: target.username,
            build1: builds[0],
            build2: builds[1],
            build3: builds[2] ?? null,
            build4: builds[3] ?? null,
            build5: builds[4] ?? null,
            status: 'ACTIVE',
            warnings: 0,
            registeredAt: new Date(),
            lastMatchAt: null,
          },
        });
        await reactivatePlayerOnLadder(target.id, target.username, builds);
      } else {
        await prisma.player.create({
          data: {
            discordId: target.id,
            discordUsername: target.username,
            build1: builds[0],
            build2: builds[1],
            build3: builds[2] ?? null,
            build4: builds[3] ?? null,
            build5: builds[4] ?? null,
            seasonId: season.id,
          },
        });
        await addPlayerToLadder(target.id, target.username, builds);
      }

      const buildList = builds
        .map((b) => { const e = getClassEmoji(b); return e ? `${e} ${b}` : b; })
        .join('\n');
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Player Registered')
            .setDescription(`<@${target.id}> has been registered for **${season.name}**.`)
            .addFields({ name: 'Registered Builds', value: buildList, inline: false })
            .setFooter({ text: `Registered by ${interaction.user.username}` })
            .setTimestamp(),
        ],
      });

      const signUpChannel = interaction.client.channels.cache.get(CHANNELS.signUpHere) as TextChannel | undefined;
      if (signUpChannel) {
        await signUpChannel.send({ embeds: [buildRegistrationEmbed(target.username, target.id, builds)] });
      }

      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        const logFields = [
          { name: 'Player', value: `<@${target.id}> (${target.username})`, inline: true },
          { name: 'Registered By', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Season', value: season.name, inline: true },
          { name: 'Registered Builds', value: buildList, inline: false },
        ];
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Blurple)
              .setTitle('Admin: Player Registered')
              .addFields(...logFields)
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      console.error('[/admin-register]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Registration failed. Check server logs.')] });
    }
  },
};
