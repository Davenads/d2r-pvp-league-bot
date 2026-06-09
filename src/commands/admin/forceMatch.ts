/**
 * /admin-force-match
 *
 * Mod-only command to force a match between two registered players.
 * Supports two match types via the optional `match_type` argument:
 *   - Standard (default): normal result scoring — winner +1, loser +0
 *   - Tournament: elevated scoring — winner +2, loser +1
 *
 * - Computes all allowed build pairings via getAllowedMatchups
 * - Bot randomly selects one pairing and creates the Prisma Match record immediately
 * - If all pairings are banned, shows override prompt (preserves match type through to override)
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ChannelType,
} from 'discord.js';
import type { ThreadChannel } from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, EMBED_COLORS, CAIN_EMOJI } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import {
  getAllowedMatchups,
  selectRandomPairing,
  setPlayerState,
  getPlayerState,
  addActiveMatch,
} from '../../services/queue.js';
import { CHANNELS } from '../../config/channels.js';
import { ROLES } from '../../config/roles.js';
import { assertModRole } from '../../utils/modGuard.js';
import { postAllBannedEmbed, postMatchAnnouncementEmbed } from '../../utils/matchupUI.js';

const MATCH_TYPE_CHOICES = ['Standard', 'Tournament'] as const;
type ForceMatchType = typeof MATCH_TYPE_CHOICES[number];

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-force-match')
    .setDescription('Force a match between two players — Standard (default) or Tournament scoring (mod only)')
    .addUserOption((opt) =>
      opt.setName('player1').setDescription('First player').setRequired(true)
    )
    .addUserOption((opt) =>
      opt.setName('player2').setDescription('Second player').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('match_type')
        .setDescription('Standard (winner +1) or Tournament (winner +2, loser +1) — defaults to Standard')
        .setRequired(false)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();
    const filtered = MATCH_TYPE_CHOICES.filter((c) => c.toLowerCase().startsWith(focused));
    await interaction.respond(filtered.map((c) => ({ name: c, value: c })));
  },

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const p1User = interaction.options.getUser('player1', true);
    const p2User = interaction.options.getUser('player2', true);
    const matchTypeRaw = interaction.options.getString('match_type') ?? 'Standard';

    // Normalise — accept any casing, fall back to Standard for unknown values
    const matchTypeInput = MATCH_TYPE_CHOICES.find(
      (c) => c.toLowerCase() === matchTypeRaw.toLowerCase()
    ) ?? 'Standard' as ForceMatchType;

    const isTournament = matchTypeInput === 'Tournament';
    const prismaMatchType = isTournament ? 'TOURNAMENT' : 'STANDARD';

    if (p1User.id === p2User.id) {
      await interaction.editReply({ embeds: [buildErrorEmbed('player1 and player2 must be different users.')] });
      return;
    }

    try {
      const season = await prisma.season.findFirst({ where: { active: true } });
      if (!season) {
        await interaction.editReply({ embeds: [buildErrorEmbed('No active season.')] });
        return;
      }

      const [p1Record, p2Record] = await Promise.all([
        prisma.player.findFirst({ where: { discordId: p1User.id, seasonId: season.id } }),
        prisma.player.findFirst({ where: { discordId: p2User.id, seasonId: season.id } }),
      ]);

      if (!p1Record) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p1User.username}** is not registered this season.`)] });
        return;
      }
      if (!p2Record) {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p2User.username}** is not registered this season.`)] });
        return;
      }
      if (p1Record.status === 'REMOVED') {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p1User.username}** has been removed from the league.`)] });
        return;
      }
      if (p2Record.status === 'REMOVED') {
        await interaction.editReply({ embeds: [buildErrorEmbed(`**${p2User.username}** has been removed from the league.`)] });
        return;
      }

      // Warn if either player is already in a match — mod can proceed anyway
      const [p1State, p2State] = await Promise.all([
        getPlayerState(p1User.id),
        getPlayerState(p2User.id),
      ]);
      const stateWarning =
        (p1State === 'in_match' ? `⚠️ **${p1User.username}** is currently marked as in_match.\n` : '') +
        (p2State === 'in_match' ? `⚠️ **${p2User.username}** is currently marked as in_match.\n` : '');

      // Compute all allowed matchup combinations with deathmatch tagging
      const { available, allBanned } = await getAllowedMatchups(p1Record, p2Record);

      // Set both players to in_match
      await Promise.all([
        setPlayerState(p1User.id, 'in_match'),
        setPlayerState(p2User.id, 'in_match'),
      ]);

      // Thread name reflects match type
      const threadName = isTournament
        ? `Tournament: ${p1User.username} vs ${p2User.username}`
        : `Match: ${p1User.username} vs ${p2User.username}`;

      // Create private match thread
      const threadParent = interaction.client.channels.cache.get(CHANNELS.matchThreads) as TextChannel | undefined;
      let thread: ThreadChannel | undefined;

      if (threadParent) {
        try {
          thread = await threadParent.threads.create({
            name: threadName,
            type: ChannelType.PrivateThread,
            reason: `D2R 1v1 League forced ${matchTypeInput.toLowerCase()} match`,
          }) as ThreadChannel;

          await thread.members.add(p1User.id);
          await thread.members.add(p2User.id);

          // Add all 1v1 Moderator role members to the thread
          const guild = interaction.guild;
          if (guild) {
            const modRole = guild.roles.cache.get(ROLES.mod)
              ?? await guild.roles.fetch(ROLES.mod).catch(() => null);
            if (modRole) {
              for (const [modId] of modRole.members) {
                await thread.members.add(modId).catch(() => {
                  console.warn(`[/admin-force-match] Could not add mod ${modId} to thread`);
                });
              }
              await thread.send({ content: `<@&${ROLES.mod}>` }).catch(() => {
                console.warn('[/admin-force-match] Could not post mod ping in thread');
              });
            }
          }
        } catch (threadErr) {
          console.error('[/admin-force-match] Failed to create match thread:', threadErr);
        }
      }

      if (allBanned) {
        // All pairings banned — post override prompt; pass match type so override handler uses it
        if (thread) {
          await postAllBannedEmbed(thread, p1User.id, p2User.id, prismaMatchType as 'STANDARD' | 'TOURNAMENT');
        }

        const bannedTitle = isTournament
          ? `${CAIN_EMOJI} Tournament Match — All Pairings Banned`
          : `${CAIN_EMOJI} Forced Match — All Pairings Banned`;

        const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
        if (resultsChannel) {
          await resultsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(EMBED_COLORS.warning)
                .setTitle(bannedTitle)
                .setDescription(
                  `<@${p1User.id}> vs <@${p2User.id}> — awaiting override decision` +
                  (thread ? `\n\n**Thread:** <#${thread.id}>` : '')
                )
                .setTimestamp(),
            ],
          });
        }

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle(`${CAIN_EMOJI} All Matchups Banned`)
              .setDescription(
                (stateWarning ? stateWarning + '\n' : '') +
                `All build pairings between <@${p1User.id}> and <@${p2User.id}> are banned.\n\n` +
                `An override prompt has been posted in the thread.` +
                (thread ? `\n\n**Thread:** <#${thread.id}>` : '')
              )
              .setTimestamp(),
          ],
        });
        return;
      }

      // Randomly select a pairing
      const selected = selectRandomPairing(available);

      // Create Prisma Match record immediately
      const match = await prisma.match.create({
        data: {
          seasonId: season.id,
          player1Id: p1Record.id,
          player2Id: p2Record.id,
          build1Used: selected.build1,
          build2Used: selected.build2,
          type: prismaMatchType,
          status: 'PENDING',
          threadId: thread?.id,
        },
      });

      // Register match in both players' active match SETs
      await addActiveMatch(match.id, p1User.id, p2User.id);

      // Post match announcement in thread
      if (thread) {
        await postMatchAnnouncementEmbed(
          thread,
          selected,
          p1User.id,
          p2User.id,
          match.id,
          isTournament,
        );
      }

      // Post public notification to #1v1-match-results
      const resultsChannel = interaction.client.channels.cache.get(CHANNELS.matchResults) as TextChannel | undefined;
      if (resultsChannel) {
        const publicDescription = isTournament
          ? `<@${p1User.id}> vs <@${p2User.id}>\n` +
            `**Matchup:** ${selected.build1} vs ${selected.build2}\n` +
            `**Points:** Winner **+2** | Loser **+1**` +
            (thread ? `\n\n**Thread:** <#${thread.id}>` : '')
          : `<@${p1User.id}> vs <@${p2User.id}>\n` +
            `**Matchup:** ${selected.build1} vs ${selected.build2}` +
            (thread ? `\n\n**Thread:** <#${thread.id}>` : '');

        await resultsChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle(isTournament
                ? `${CAIN_EMOJI} Tournament Match Assigned`
                : `${CAIN_EMOJI} Match Assigned (Forced)`)
              .setDescription(publicDescription)
              .setTimestamp(),
          ],
        });
      }

      // Mod log
      const logChannel = interaction.client.channels.cache.get(CHANNELS.modLogs) as TextChannel | undefined;
      if (logChannel) {
        await logChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLORS.warning)
              .setTitle(isTournament
                ? `${CAIN_EMOJI} Admin: Tournament Match Created`
                : `${CAIN_EMOJI} Admin: Standard Match Forced`)
              .addFields(
                { name: 'Created By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Match Type', value: matchTypeInput, inline: true },
                { name: 'Player 1', value: `<@${p1User.id}> (${selected.build1})`, inline: true },
                { name: 'Player 2', value: `<@${p2User.id}> (${selected.build2})`, inline: true },
                { name: 'Match #', value: String(match.id), inline: true },
                ...(thread ? [{ name: 'Thread', value: `<#${thread.id}>`, inline: false }] : []),
              )
              .setTimestamp(),
          ],
        });
      }

      // Ephemeral reply to mod
      const replyFooter = isTournament
        ? 'Winner +2 pts | Loser +1 pt — applied on result confirm.'
        : 'Winner +1 pt | Loser +0 pts — applied on result confirm.';

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle(isTournament
              ? `${CAIN_EMOJI} Tournament Match Created`
              : `${CAIN_EMOJI} Match Forced (Standard)`)
            .setDescription(
              (stateWarning ? stateWarning + '\n' : '') +
              `Match #${match.id} (${matchTypeInput}) created between <@${p1User.id}> and <@${p2User.id}>.\n\n` +
              `**Matchup:** ${selected.build1} vs ${selected.build2}` +
              (thread ? `\n\n**Thread:** <#${thread.id}>` : '')
            )
            .setFooter({ text: replyFooter })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('[/admin-force-match]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
