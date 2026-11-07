/**
 * Permanent identity-contract regression for ADR-0003 (fork team identity).
 *
 * DSH 0.2.2 ordinary forks no longer record `header.parentSession`, and a fork
 * is an independent root conversation: it never inherits the lead of the team
 * its source session led (this supersedes the #176 inheritance behaviour). Team
 * identity is the exact recorded `captainSessionId`. These cases run
 * `teamLeadMatch` and `isTopLevelSession` as pure functions over plain values —
 * no mocked Context, Agents registry, LLM or team state — and pin the exact
 * boundary: only the recorded captain leads, members never do, and a fork never
 * does, with or without a roster.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { isTopLevelSession, teamLeadMatch } from '../lib/lineage.js'

/** Plain team record as `findTeamByCaptain`/`findTeamByParticipant` see it. */
const team = members => ({ captainSessionId: 'session-captain', members })
const identity = (sessionId, ancestry = [], inheritsLead = false) => ({ sessionId, ancestry, inheritsLead })

const activeMembers = [
  { id: 'session-member', status: 'working' },
  { id: 'session-retired', status: 'removed' },
]

test('the recorded captain leads its own team', () => {
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-captain')), true)
  // An identity that claims no ancestry still matches by exact id.
  assert.equal(teamLeadMatch(team([]), identity('session-captain')), true)
  assert.equal(teamLeadMatch(team(undefined), identity('session-captain')), true)
})

test('a top-level fork never inherits the lead of its source team', () => {
  // ADR-0003: a fork is an independent root; ancestry is not lead identity.
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-fork', ['session-captain'], true)), false)
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-grandchild', ['session-fork', 'session-captain'], true)), false)
})

test('a team without roster rows still does not let a fork inherit the lead', () => {
  // Regression for the "you already lead team" trap: even with no members the
  // exact-id contract stands, so a fork cannot claim the parent captain's team.
  assert.equal(teamLeadMatch(team(undefined), identity('session-fork', ['session-captain'], true)), false)
  assert.equal(teamLeadMatch(team([]), identity('session-fork', ['session-captain'], true)), false)
})

test('a member session never leads, even claiming the captain as ancestor', () => {
  // Member sessions are subagent children: leadIdentityOf reports a non-fork
  // header, and defence in depth rejects them by listed member id too.
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-member', ['session-captain'], false)), false)
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-member', ['session-captain'], true)), false)
})

test('a member fork never inherits lead identity through its member ancestor', () => {
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-fork-of-member', ['session-member', 'session-captain'], true)), false)
})

test('a retired member never regains lead identity, and neither does its fork', () => {
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-retired', ['session-captain'], true)), false)
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-fork-of-retired', ['session-retired', 'session-captain'], true)), false)
  // The same holds when the roster row carries no status at all.
  assert.equal(teamLeadMatch(team([{ id: 'session-retired' }]), identity('session-retired', ['session-captain'], true)), false)
})

test('an unrelated session neither leads nor inherits', () => {
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-other', [], true)), false)
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-other', ['session-unrelated'], true)), false)
  // Ancestry that contains the captain id is still refused for a non-captain.
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-other', ['session-retired', 'session-captain'], true)), false)
})

test('an identity that cannot inherit lead is never widened by ancestry', () => {
  assert.equal(teamLeadMatch(team(activeMembers), identity('session-fork', ['session-captain'], false)), false)
})

test('isTopLevelSession identifies ordinary forks: seeded, non-subagent, depth zero', () => {
  // A header without `isSeeded` (a normal, non-fork session) is not a fork.
  assert.equal(isTopLevelSession({ header: {} }), false)
  assert.equal(isTopLevelSession({ header: { isSeeded: false } }), false)
  // An ordinary fork: seeded, not a subagent child, at delegation depth zero.
  assert.equal(isTopLevelSession({ header: { isSeeded: true } }), true)
  assert.equal(isTopLevelSession({ header: { isSeeded: true, delegationDepth: 0 } }), true)
  // A seeded subagent child, or a seeded session past depth zero, is not an
  // ordinary fork and must not be treated as one.
  assert.equal(isTopLevelSession({ header: { isSeeded: true, origin: 'subagent' } }), false)
  assert.equal(isTopLevelSession({ header: { isSeeded: true, delegationDepth: 1 } }), false)
  assert.equal(isTopLevelSession({ header: { isSeeded: true, origin: 'subagent', delegationDepth: 0 } }), false)
  // A sealed sub-agent / deeper header alone is never a top-level fork.
  assert.equal(isTopLevelSession({ header: { origin: 'subagent' } }), false)
  assert.equal(isTopLevelSession({ header: { delegationDepth: 0 } }), false)
})
