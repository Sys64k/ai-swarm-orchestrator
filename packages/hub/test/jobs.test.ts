import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addBuildUsage, endJob, failedBuildResult, JOBS_LIMIT, lastBuild, markAcceptance, markOverturned, markQa, markVerified, openJob, startJob } from "@aso/hub";

const desk = (slot = 1, nodeId = "avalon-1") => ({ host: "avalon", slot, nodeId });

describe("a task's job records", () => {
  it("follows a build from its desk to its result and the verdicts on its work", () => {
    let jobs = startJob(undefined, "implement", desk(2), 0, "t1");
    jobs = startJob(jobs, "implement", desk(2), 0, "t2");
    assert.equal(jobs.length, 1, "the same desk reporting again starts nothing new");
    addBuildUsage(jobs, 0.1234567);
    addBuildUsage(jobs, 0.1);
    assert.deepEqual([jobs[0].calls, jobs[0].costUsd], [2, 0.223457]);
    endJob(jobs, "implement", "pushed", "t3");
    assert.equal(openJob(jobs, "implement"), undefined);
    addBuildUsage(jobs, 1);
    assert.equal(jobs[0].costUsd, 0.223457, "an ended build costs nothing more");
    markVerified(jobs, true);
    markQa(jobs, false);
    markAcceptance(jobs, "unmet");
    assert.deepEqual([jobs[0].result, jobs[0].qa, jobs[0].acceptance, jobs[0].endedAt], ["built", "failed", "unmet", "t3"]);
    markVerified(jobs, false);
    assert.equal(jobs[0].result, "built", "only a pushed build is verified");
  });

  it("ends a job left open on another desk as dropped, and keeps builds and QA runs apart", () => {
    let jobs = startJob(undefined, "implement", desk(1), 0, "t1");
    jobs = startJob(jobs, "test", desk(1, "canfod-1"), 0, "t2");
    assert.equal(openJob(jobs, "implement")?.slot, 1, "a QA run doesn't end the build");
    jobs = startJob(jobs, "implement", desk(3), 1, "t3");
    assert.deepEqual(jobs.map((j) => [j.job, j.slot, j.result ?? "open"]), [["implement", 1, "dropped"], ["test", 1, "open"], ["implement", 3, "open"]]);
    assert.equal(lastBuild(jobs)?.round, 1);
    endJob(jobs, "test", "passed", "t4");
    assert.equal(jobs[1].result, "passed");
    endJob([], "test", "passed", "t5"); // nothing open: nothing happens
  });

  it("keeps at most JOBS_LIMIT records, dropping the oldest", () => {
    let jobs = startJob(undefined, "implement", desk(1, "n0"), 0, "t");
    for (let i = 1; i <= JOBS_LIMIT; i++) jobs = startJob(jobs, "implement", desk(1, `n${i}`), i, "t");
    assert.equal(jobs.length, JOBS_LIMIT);
    assert.equal(jobs[0].nodeId, "n1");
  });

  it("marks a met verdict that proved wrong later, once, and nothing else", () => {
    const jobs = startJob(undefined, "implement", desk(), 0, "t1");
    endJob(jobs, "implement", "pushed", "t2");
    markVerified(jobs, true);
    markAcceptance(jobs, "unmet");
    assert.equal(markOverturned(jobs, "changesRequested"), false, "an unmet verdict wasn't wrong to pass anything");
    markAcceptance(jobs, "met");
    assert.equal(markOverturned(jobs, "changesRequested"), true);
    assert.equal(markOverturned(jobs, "deployFailed"), false, "the first reason stays");
    assert.equal(jobs[0].overturned, "changesRequested");
    assert.equal(markOverturned(undefined, "closed"), false, "a task without builds");
  });

  it("names how a failed build ended", () => {
    assert.equal(failedBuildResult({ switchingModel: true, outOfTurns: true }), "modelRefused");
    assert.equal(failedBuildResult({ outOfTurns: true }), "outOfTurns");
    assert.equal(failedBuildResult({}), "failed");
  });
});
