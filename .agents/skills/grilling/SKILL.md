---
name: grilling
description: Interview the user relentlessly about a plan, decision or idea, one round of numbered questions at a time. Use when they ask to be grilled or to stress-test their thinking.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job; the user supplies _decisions_. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent for it and keep the round moving: the running exploration is an unsettled prerequisite, so only the questions downstream of it wait for its report, and the rest of the frontier goes out now. Each decision goes to the user, and you wait for the answer.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Acting on the design starts once the user confirms the shared understanding.
