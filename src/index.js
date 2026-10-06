const minimatch = require("minimatch").minimatch;
const process = require("process");
const path = require("path");
const fs = require("fs");
const { validateSubscription } = require("./subscription");

// @octokit/rest v20+ is ESM-only, so it must be loaded via dynamic import
// from this CommonJS module. ncc bundles the resolved module correctly.
async function loadOctokit() {
    const { Octokit } = await import("@octokit/rest");
    return Octokit;
}

async function getNewestPRNumberByBranch(octokit, branchName, repo) {
    const pullRequests = await octokit.paginate(
        octokit.pulls.list,
        {
            owner: repo.owner.login,
            repo: repo.name,
            state: "all",
            head: `${repo.owner.login}:${branchName}`,
        },
        (response) => response.data
    );

    if (pullRequests.length === 0) {
        console.info(`No PRs found for branch ${branchName}`);
        process.exit(1);
    }

    pullRequests.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const newestPR = pullRequests[0].number;
    return newestPR;
}

// Normalize a raw CODEOWNERS owner token into a lowercase slug/login.
// Teams (`@org/team`) collapse to `team`; bare users (`@user`) collapse to `user`.
function normalizeOwner(owner) {
    owner = owner.replace(/[<>\(\)\[\]\{\},;+*?=]/g, "");
    owner = owner.replace("@", "").split("/").pop();
    return owner.toLowerCase();
}

// Parse CODEOWNERS content and, for the given changed files, build a map of
// required owner slugs -> approval state (initialized to false).
function parseCodeowners(codeownersContent, changedFiles) {
    const codeownersLines = codeownersContent.split("\n");
    const codeowners = {};

    function updateCodeowners(owners) {
        for (const rawOwner of owners) {
            const owner = normalizeOwner(rawOwner);
            if (!owner) {
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(codeowners, owner)) {
                codeowners[owner] = false;
            }
        }
    }

    for (const line of codeownersLines) {
        if (!line.trim() || line.startsWith("#")) {
            continue;
        }

        let [pattern, ...owners] = line.trim().split(/\s+/);

        if (pattern === "*") {
            updateCodeowners(owners);
        } else {
            if (!pattern.startsWith("/") && !pattern.startsWith("*")) {
                pattern = `{**/,}${pattern}`;
            }
            if (!path.extname(pattern) && !pattern.endsWith("*")) {
                pattern = `${pattern}{/**,}`;
            }
            for (let changedFile of changedFiles) {
                changedFile = `/${changedFile}`;
                if (minimatch(changedFile, pattern, { dot: true })) {
                    console.log(`Match found: File - ${changedFile}, Pattern - ${pattern}`);
                    updateCodeowners(owners);
                }
            }
        }
    }

    return codeowners;
}

async function getRequiredCodeowners(changedFiles, repo, pr, octokit) {
    const codeownersContent =
        (await getContent(octokit, repo, ".github/CODEOWNERS", pr.base.ref)) ||
        (await getContent(octokit, repo, "CODEOWNERS", pr.base.ref));

    if (!codeownersContent) {
        console.info("No CODEOWNERS file found");
        process.exit(1);
    }

    return parseCodeowners(codeownersContent, changedFiles);
}

async function getUserTeams(username, orgName, orgTeams, octokit) {
    const teams = [];

    for (const team of orgTeams) {
        const teamMembers = await octokit.paginate(
            octokit.teams.listMembersInOrg,
            {
                org: orgName,
                team_slug: team.slug,
            },
            (response) => response.data
        );

        const memberLogins = teamMembers.map((member) => member.login);
        if (memberLogins.includes(username)) {
            teams.push(team);
        }
    }

    return teams;
}

async function getContent(octokit, repo, path, ref) {
    try {
        const { data } = await octokit.repos.getContent({
            owner: repo.owner.login,
            repo: repo.name,
            path,
            ref,
            headers: {
                // Raw media type necessary for files over 1MB
                accept: "application/vnd.github.v3.raw",
            }
        });
        return data;
    } catch (error) {
        if (error.status === 404) {
            return null;
        }
        throw error;
    }
}

// Evaluate PR reviews against required codeowners.
// Mutates a copy of requiredCodeownerEntities and returns the approval outcome.
// reviewsWithTeams: array of { review, userTeams } where review has
//   { state, commit_id, user: { login } } and userTeams is an array of { slug }.
function evaluateReviews(requiredCodeownerEntities, reviewsWithTeams, options) {
    const { requireAllApprovalsLatestCommit, headSha } = options;
    const entities = { ...requiredCodeownerEntities };
    const approvedCodeowners = [];

    const isLatestCommit = (review) =>
        requireAllApprovalsLatestCommit !== "true" || review.commit_id === headSha;

    const addApprover = (login) => {
        if (!approvedCodeowners.includes(login)) {
            approvedCodeowners.push(login);
        }
    };

    for (const { review, userTeams } of reviewsWithTeams) {
        const reviewerLogin = review.user.login.toLowerCase();

        if (review.state === "APPROVED") {
            for (const team of userTeams) {
                if (Object.prototype.hasOwnProperty.call(entities, team.slug)) {
                    if (!isLatestCommit(review)) {
                        console.info(
                            `  ${reviewerLogin} ${review.state}: at commit: ${review.commit_id} for: ${team.slug} (not the latest commit, ignoring)`
                        );
                        continue;
                    }
                    entities[team.slug] = true;
                    addApprover(review.user.login);
                    console.info(
                        `  ${reviewerLogin} ${review.state}: at commit: ${review.commit_id} for: ${team.slug}`
                    );
                }
            }

            if (Object.prototype.hasOwnProperty.call(entities, reviewerLogin)) {
                if (!isLatestCommit(review)) {
                    console.info(
                        `  ${reviewerLogin} ${review.state}: at commit: ${review.commit_id} (not the latest commit, ignoring)`
                    );
                } else {
                    entities[reviewerLogin] = true;
                    addApprover(review.user.login);
                    console.info(
                        `  ${reviewerLogin} ${review.state}: at commit: ${review.commit_id}`
                    );
                }
            }
        } else if (review.state === "CHANGES_REQUESTED") {
            for (const team of userTeams) {
                if (Object.prototype.hasOwnProperty.call(entities, team.slug)) {
                    entities[team.slug] = false;
                    console.info(`  ${reviewerLogin} ${review.state}: for: ${team.slug}`);
                }
            }
            if (Object.prototype.hasOwnProperty.call(entities, reviewerLogin)) {
                entities[reviewerLogin] = false;
                console.info(`  ${reviewerLogin} ${review.state}: for: ${reviewerLogin}`);
            }
        } else {
            console.debug(`  ${reviewerLogin} ${review.state}: ignoring`);
        }
    }

    return { entities, approvedCodeowners };
}

// Compute the final approval decision and human-readable reason.
function computeApprovalResult(entities, approvedCodeowners, options) {
    const { approvalMode, minApprovals } = options;

    const allCodeownersApproved = Object.values(entities).every((value) => value);
    const anyCodeownerApproved = Object.values(entities).some((value) => value);

    const codeownersApprovalsCheck =
        approvalMode === "ANY" ? anyCodeownerApproved : allCodeownersApproved;
    const uniqueApprovals = new Set(approvedCodeowners).size;
    const minApprovalsMet = uniqueApprovals >= minApprovals;

    let coReason;
    if (approvalMode === "ANY") {
        coReason = anyCodeownerApproved
            ? "At least one of the codeowners has approved."
            : "None of the codeowners has approved.";
    } else {
        coReason = allCodeownersApproved
            ? "All codeowners have approved."
            : "Not all codeowners have approved.";
    }

    const maReason = minApprovalsMet
        ? `total approvals:${uniqueApprovals} >= minimum approvals:${minApprovals}`
        : `total approvals:${uniqueApprovals} < minimum approvals:${minApprovals}`;
    const reason = `${coReason} and ${maReason}`;

    const approved = codeownersApprovalsCheck && minApprovalsMet;

    return { approved, reason };
}

async function main() {
    await validateSubscription();

    const token = process.env["INPUT_TOKEN"];
    const readOrgToken = process.env["INPUT_READ_ORG_SCOPED_TOKEN"];
    const orgName = process.env["INPUT_ORG_NAME"];
    const minApprovals = parseInt(process.env["INPUT_MIN_APPROVALS"], 10);
    const requireAllApprovalsLatestCommit =
        process.env["INPUT_REQUIRE_ALL_APPROVALS_LATEST_COMMIT"];
    const ghRef = process.env["GITHUB_REF"];
    const ghRepo = process.env["GITHUB_REPOSITORY"];
    const approvalMode = process.env["INPUT_APPROVAL_MODE"];

    const Octokit = await loadOctokit();
    const octokit = new Octokit({ auth: token });
    const readOrgOctokit = new Octokit({ auth: readOrgToken });

    const [owner, repoName] = ghRepo.split("/");
    const repo = await octokit.repos.get({ owner, repo: repoName });

    const allOrgTeams = await readOrgOctokit.paginate(
        readOrgOctokit.teams.list,
        { org: orgName },
        (response) => response.data
    );

    let prNumber;
    if (process.env["INPUT_BRANCH"] && process.env["INPUT_BRANCH"] !== "") {
        prNumber = await getNewestPRNumberByBranch(octokit, process.env["INPUT_BRANCH"], repo.data);
    } else if (process.env["INPUT_PR_NUMBER"] && process.env["INPUT_PR_NUMBER"] !== "") {
        prNumber = parseInt(process.env["INPUT_PR_NUMBER"], 10);
    } else {
        const ghRefParts = ghRef.split("/");
        prNumber = parseInt(ghRefParts[ghRefParts.length - 2], 10);
    }

    const { data: pr } = await octokit.pulls.get({
        owner: repo.data.owner.login,
        repo: repo.data.name,
        pull_number: prNumber,
    });

    const reviews = await octokit.paginate(
        octokit.pulls.listReviews,
        {
            owner: repo.data.owner.login,
            repo: repo.data.name,
            pull_number: pr.number,
        },
        (response) => response.data
    );

    const changedFiles = await octokit.paginate(
        octokit.pulls.listFiles,
        {
            owner: repo.data.owner.login,
            repo: repo.data.name,
            pull_number: pr.number
        },
        (response) => response.data.map((f) => f.filename)
    );

    const requiredCodeownerEntities = await getRequiredCodeowners(changedFiles, repo.data, pr, octokit);
    console.info(`Required codeowners: ${Object.keys(requiredCodeownerEntities).join(', ')}`);

    let orgTeams = [];

    if (process.env["INPUT_LIMIT_ORG_TEAMS_TO_CODEOWNERS_FILE"] === "true") {
        const requiredCodeownerEntitySlugs = new Set(Object.keys(requiredCodeownerEntities));
        const filteredTeams = allOrgTeams.filter((team) => {
            return requiredCodeownerEntitySlugs.has(team.slug);
        });

        if (filteredTeams.length !== requiredCodeownerEntitySlugs.size) {
            for (const slug of requiredCodeownerEntitySlugs) {
                if (!filteredTeams.some((team) => team.slug === slug)) {
                    console.warn(`  Team: ${slug} not found in Org: ${orgName}`);
                }
            }
        }
        orgTeams.push(...filteredTeams);
    } else {
        orgTeams = allOrgTeams;
    }

    const reviewsWithTeams = [];
    for (const review of reviews) {
        const userTeams = await getUserTeams(review.user.login, orgName, orgTeams, readOrgOctokit);
        reviewsWithTeams.push({ review, userTeams });
    }

    const { entities, approvedCodeowners } = evaluateReviews(
        requiredCodeownerEntities,
        reviewsWithTeams,
        { requireAllApprovalsLatestCommit, headSha: pr.head.sha }
    );

    const { approved, reason } = computeApprovalResult(entities, approvedCodeowners, {
        approvalMode,
        minApprovals,
    });

    const outputPath = process.env["GITHUB_OUTPUT"];
    fs.appendFileSync(
        outputPath,
        `approved=${approved.toString().toLowerCase()}\nreason=${reason}\n`
    );

    if (approved) {
        console.info(`Required approvals met: ${reason}`);
        process.exit(0);
    } else {
        console.warn(`Required approvals not met: ${reason}`);
        process.exit(1);
    }
}

module.exports = {
    normalizeOwner,
    parseCodeowners,
    evaluateReviews,
    computeApprovalResult,
    main,
};

// Only run automatically when executed directly (not when imported by tests).
if (require.main === module) {
    main();
}
