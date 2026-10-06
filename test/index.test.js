const { test } = require("node:test");
const assert = require("node:assert");

const {
    normalizeOwner,
    parseCodeowners,
    evaluateReviews,
    computeApprovalResult,
} = require("../src/index.js");

const HEAD = "headsha";

function review(login, state, commit = HEAD) {
    return { state, commit_id: commit, user: { login } };
}

test("normalizeOwner: team collapses to slug", () => {
    assert.strictEqual(normalizeOwner("@org/team1"), "team1");
});

test("normalizeOwner: bare user collapses to login", () => {
    assert.strictEqual(normalizeOwner("@user1"), "user1");
});

test("normalizeOwner: strips punctuation and lowercases", () => {
    assert.strictEqual(normalizeOwner("@Org/Team-A,"), "team-a");
});

test("parseCodeowners: wildcard captures all owners", () => {
    const co = parseCodeowners("* @ourgroup @user1 @user2", ["any/file.js"]);
    assert.deepStrictEqual(co, { ourgroup: false, user1: false, user2: false });
});

test("parseCodeowners: path pattern only matches changed files", () => {
    const content = "* @team1\n/.github/ @team4";
    const co = parseCodeowners(content, [".github/workflows/ci.yml"]);
    // team1 from wildcard, team4 from path match
    assert.deepStrictEqual(co, { team1: false, team4: false });
});

test("parseCodeowners: ignores comments and blank lines", () => {
    const content = "# comment\n\n* @team1";
    const co = parseCodeowners(content, ["file.js"]);
    assert.deepStrictEqual(co, { team1: false });
});

// Regression for issue #22: a bare user's approval must count toward min_approvals.
test("evaluateReviews: bare user approval counts as an approver (#22)", () => {
    const required = { ourgroup: false, user1: false, user2: false };
    const reviewsWithTeams = [
        { review: review("user2", "APPROVED"), userTeams: [] },
    ];
    const { entities, approvedCodeowners } = evaluateReviews(required, reviewsWithTeams, {
        requireAllApprovalsLatestCommit: "true",
        headSha: HEAD,
    });
    assert.strictEqual(entities.user2, true);
    assert.deepStrictEqual(approvedCodeowners, ["user2"]);
});

test("evaluateReviews: bare user + ANY mode meets a single approval requirement (#22)", () => {
    const required = { ourgroup: false, user1: false, user2: false };
    const reviewsWithTeams = [
        { review: review("user2", "APPROVED"), userTeams: [] },
    ];
    const { entities, approvedCodeowners } = evaluateReviews(required, reviewsWithTeams, {
        requireAllApprovalsLatestCommit: "true",
        headSha: HEAD,
    });
    const { approved, reason } = computeApprovalResult(entities, approvedCodeowners, {
        approvalMode: "ANY",
        minApprovals: 1,
    });
    assert.strictEqual(approved, true, reason);
    assert.match(reason, /total approvals:1 >= minimum approvals:1/);
});

test("evaluateReviews: team approval counts and marks slug", () => {
    const required = { team1: false };
    const reviewsWithTeams = [
        { review: review("alice", "APPROVED"), userTeams: [{ slug: "team1" }] },
    ];
    const { entities, approvedCodeowners } = evaluateReviews(required, reviewsWithTeams, {
        requireAllApprovalsLatestCommit: "true",
        headSha: HEAD,
    });
    assert.strictEqual(entities.team1, true);
    assert.deepStrictEqual(approvedCodeowners, ["alice"]);
});

// Regression: latest-commit gate must apply to bare users too.
test("evaluateReviews: stale bare user approval is ignored when latest-commit required", () => {
    const required = { user1: false };
    const reviewsWithTeams = [
        { review: review("user1", "APPROVED", "oldsha"), userTeams: [] },
    ];
    const { entities, approvedCodeowners } = evaluateReviews(required, reviewsWithTeams, {
        requireAllApprovalsLatestCommit: "true",
        headSha: HEAD,
    });
    assert.strictEqual(entities.user1, false);
    assert.deepStrictEqual(approvedCodeowners, []);
});

test("evaluateReviews: stale bare user approval counts when latest-commit not required", () => {
    const required = { user1: false };
    const reviewsWithTeams = [
        { review: review("user1", "APPROVED", "oldsha"), userTeams: [] },
    ];
    const { entities, approvedCodeowners } = evaluateReviews(required, reviewsWithTeams, {
        requireAllApprovalsLatestCommit: "false",
        headSha: HEAD,
    });
    assert.strictEqual(entities.user1, true);
    assert.deepStrictEqual(approvedCodeowners, ["user1"]);
});

test("evaluateReviews: CHANGES_REQUESTED resets bare user approval", () => {
    const required = { user1: false };
    const reviewsWithTeams = [
        { review: review("user1", "APPROVED"), userTeams: [] },
        { review: review("user1", "CHANGES_REQUESTED"), userTeams: [] },
    ];
    const { entities } = evaluateReviews(required, reviewsWithTeams, {
        requireAllApprovalsLatestCommit: "true",
        headSha: HEAD,
    });
    assert.strictEqual(entities.user1, false);
});

test("evaluateReviews: does not mutate the input entities object", () => {
    const required = { user1: false };
    evaluateReviews(required, [
        { review: review("user1", "APPROVED"), userTeams: [] },
    ], { requireAllApprovalsLatestCommit: "true", headSha: HEAD });
    assert.strictEqual(required.user1, false);
});

test("evaluateReviews: duplicate approvals from same user counted once", () => {
    const required = { user1: false };
    const reviewsWithTeams = [
        { review: review("user1", "APPROVED"), userTeams: [] },
        { review: review("user1", "APPROVED"), userTeams: [] },
    ];
    const { approvedCodeowners } = evaluateReviews(required, reviewsWithTeams, {
        requireAllApprovalsLatestCommit: "true",
        headSha: HEAD,
    });
    assert.deepStrictEqual(approvedCodeowners, ["user1"]);
});

test("computeApprovalResult: ALL mode requires every codeowner", () => {
    const res = computeApprovalResult(
        { team1: true, team2: false },
        ["alice"],
        { approvalMode: "ALL", minApprovals: 1 }
    );
    assert.strictEqual(res.approved, false);
    assert.match(res.reason, /Not all codeowners have approved\./);
});

test("computeApprovalResult: ALL mode met", () => {
    const res = computeApprovalResult(
        { team1: true, team2: true },
        ["alice", "bob"],
        { approvalMode: "ALL", minApprovals: 2 }
    );
    assert.strictEqual(res.approved, true);
    assert.match(res.reason, /All codeowners have approved\./);
    assert.match(res.reason, /total approvals:2 >= minimum approvals:2/);
});

test("computeApprovalResult: ANY mode none approved", () => {
    const res = computeApprovalResult(
        { team1: false, team2: false },
        [],
        { approvalMode: "ANY", minApprovals: 1 }
    );
    assert.strictEqual(res.approved, false);
    assert.match(res.reason, /None of the codeowners has approved\./);
});

test("computeApprovalResult: codeowners met but min_approvals not met", () => {
    const res = computeApprovalResult(
        { team1: true },
        ["alice"],
        { approvalMode: "ANY", minApprovals: 2 }
    );
    assert.strictEqual(res.approved, false);
    assert.match(res.reason, /total approvals:1 < minimum approvals:2/);
});
