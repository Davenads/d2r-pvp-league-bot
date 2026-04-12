/**
 * /admin-forcematch
 *
 * Mod-only command to create a tournament match between two registered players.
 * - Selects builds via the standard least-disadvantaged algorithm
 * - Creates a Postgres Match record with type TOURNAMENT
 * - Sets Redis state for both players (in_match)
 * - Creates a private match thread with matchup info
 * - Points on result: winner +3, loser +1 (handled by updateLadderResult)
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import type { Command } from '../../types/index.js';
import { buildErrorEmbed, EMBED_COLORS } from '../../utils/formatters.js';
import { prisma } from '../../db/client.js';
import { selectBuilds, setActiveMatch, setPlayerState, setMatchThreadId, getPlayerState } from '../../services/queue.js';
import { getMatchupRules } from '../../services/matchup.js';
import { updateLadderResult } from '../../services/ladder.js';
import { CHANNELS } from '../../config/channels.js';
import { assertModRole } from '../../utils/modGuard.js';
import type { ActiveMatchState } from '../../types/index.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-forcematch')
    .setDescription('Force a tournament match between two players — winner +3 pts, loser +1 pt (mod only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) =>
      opt.setName('player1').setDescription('First player').setRequired(true)
    )
    .addUserOption((opt) =>
      opt.setName('player2').setDescription('Second player').setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    if (!await assertModRole(interaction)) return;

    const p1User = interaction.options.getUser('player1', true);
    const p2User = interaction.options.getUser('player2', true);

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
        p1State === 'in_match' ? `⚠️ **${p1User.username}** is currently marked as in_match.\n` : '' +
        p2State === 'in_match' ? `⚠️ **${p2User.username}** is currently marked as in_match.\n` : '';

      // Select builds
      const { build1, build2 } = await selectBuilds(p1Record, p2Record);

      // Create Postgres Match record
      const match = await prisma.match.create({
        data: {
          seasonId: season.id,
          player1Id: p1Record.id,
          player2Id: p2Record.id,
          build1Used: build1,
          build2Used: build2,
          type: 'TOURNAMENT',
          status: 'PENDING',
        },
      });

      // Set Redis state for both players
      const matchState: ActiveMatchState = {
        matchId: match.id,
        player1DiscordId: p1User.id,
        player2DiscordId: p2User.id,
        build1,
        build2,
        createdAt: Date.now(),
      };

      await Promise.all([
        setActiveMatch(matchState),
        setPlayerState(p1User.id, 'in_match'),
        setPlayerState(p2User.id, 'in_match'),
      ]);

      // Fetch matchup rules
      const rules = await getMatchupRules(build1, build2).catch(() => null);

      // Create private match thread
      const threadParent = interaction.client.channels.cache.get(CHANNELS.matchThreads) as TextChannel | undefined;
      let threadId: string | undefined;

      if (threadParent) {
        try {
          const thread = await threadParent.threads.create({
            name: `Tournament Match #${match.id}`,
            type: ChannelType.PrivateThread,
            reason: `D2R 1v1 League tournament match #${match.id}`,
          });

          threadId = thread.id;
          await thread.members.add(p1User.id);
          await thread.members.add(p2User.id);

          const matchEmbed = new EmbedBuilder()
            .setColor(Colors.Gold)
            .setTitle(`🏆 Tournament Match #${match.id} — ${build1} vs ${build2}`)
            .setDescription(
              `<@${p1User.id}> vs <@${p2User.id}>\n\n` +
              `**${p1User.username}** is playing **${build1}**\n` +
              `**${p2User.username}** is playing **${build2}**\n\n` +
              `**Match type:** Tournament\n` +
              `**Points:** Winner **+3** | Loser **+1**`
            )
            .setFooter({ text: 'FT4 format. Report the result with /report-win once done.' })
            .setTimestamp();

          const embeds = [matchEmbed];

          if (rules && !rules.isBanned) {
            const rulesEmbed = new EmbedBuilder()
              .setColor(EMBED_COLORS.rules)
              .setTitle('Matchup Rules')
              .addFields(
                { name: `${build1} Rules`, value: rules.rulesForA || '*No specific restrictions.*', inline: false },
                { name: `${build2} Rules`, value: rules.rulesForB || '*No specific restrictions.*', inline: false },
              );
            embeds.push(rulesEmbed);
          } else if (rules?.isBanned) {
            const bannedEmbed = new EmbedBuilder()
              .setColor(Colors.Red)
              .setTitle('⚠️ Banned Matchup')
              .setDescription(`**${build1}** vs **${build2}** is normally a banned matchup. Confirm with a mod before proceeding.`);
            embeds.push(bannedEmbed);
          }

          await thread.send({ content: `<@${p1User.id}> <@${p2User.id}>`, embeds });

          await setMatchThreadId(p1User.id, threadId);
          await prisma.match.update({ where: { id: match.id }, data: { threadId } });
        } catch (threadErr) {
          console.error('[/admin-forcematch] Failed to create match thread:', threadErr);
        }
      }

      // Post public notification to #1v1-queue
      const queueChannel = interaction.client.channels.cache.get(CHANNELS.queue) as TextChannel | undefined;
      if (queueChannel) {
        await queueChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(Colors.Gold)
              .setTitle('🏆 Tournament Match Assigned')
              .addFields(
                { name: 'Player 1', value: `<@${p1User.id}> — ${build1}`, inline: true },
                { name: 'Player 2', value: `<@${p2User.id}> — ${build2}`, inline: true },
                { name: 'Points', value: 'Winner **+3** | Loser **+1**', inline: true },
                ...(threadId ? [{ name: 'Thread', value: `<#${threadId}>`, inline: false }] : []),
              )
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
              .setTitle('Admin: Tournament Match Created')
              .addFields(
                { name: 'Match #', value: String(match.id), inline: true },
                { name: 'Created By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Player 1', value: `<@${p1User.id}> (${build1})`, inline: true },
                { name: 'Player 2', value: `<@${p2User.id}> (${build2})`, inline: true },
                ...(threadId ? [{ name: 'Thread', value: `<#${threadId}>`, inline: false }] : []),
              )
              .setTimestamp(),
          ],
        });
      }

      // Ephemeral reply to mod
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle('Tournament Match Created')
            .setDescription(
              (stateWarning ? stateWarning + '\n' : '') +
              `**Match #${match.id}** created between <@${p1User.id}> and <@${p2User.id}>.\n\n` +
              `**${p1User.username}:** ${build1}\n` +
              `**${p2User.username}:** ${build2}\n` +
              (threadId ? `\n**Thread:** <#${threadId}>` : '')
            )
            .setFooter({ text: 'Winner +3 pts | Loser +1 pt — applied on result confirm.' })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('[/admin-forcematch]', err);
      await interaction.editReply({ embeds: [buildErrorEmbed('Command failed. Check server logs.')] });
    }
  },
};
