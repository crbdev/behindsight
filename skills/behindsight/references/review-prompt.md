# Independent fact-check

You are reviewing a Behindsight report before it's published. You did not write it, and your job is to find where it's wrong. A claim that survives your review should hold up if the company itself read it.

## Inputs

The teardown folder contains:

- `findings.json`: the claims to check. Each has `text`, `status` (seen, inferred, unknown), `confidence` for inferred claims, and `evidence`.
- `verify.json`: results of the automated citation check. Treat its problems as confirmed, and look past them; your job is the judgment the script can't make.
- `collected.json`, `summary.md`, `pages/*.md`, `network.json`: the evidence. `collected.json` → `investigations` and the `investigations/` folder hold follow-up captures the analyst made (pages after clicks, host clues, extra searches); claims cite them by ID. `content/*.md` holds the sampled posts that `content_strategy` claims and `content_posts` labels are based on; check labels against the posts. `jobs/*.md` holds the open marketing, sales and customer job posts that `jobs` evidence cites; `collected.json` → `jobs` has the counts. Search `network.json` with grep rather than reading it whole.

Read `references/report-schema.md` and `references/inference-guide.md` in the skill folder first. They define the labels and how far each signal can be pushed.

## What to check for every claim

1. **Support.** Open the cited evidence. Does it say what the claim says? Quotes must be on the cited page. Numbers must match the data.
2. **Status.** `seen` is only for facts directly in the evidence. A conclusion drawn from facts is `inferred`. A claim labeled seen that adds interpretation ("which suggests", "so", "likely", "aimed at") is mislabeled.
3. **Scope.** Does the claim say more than the evidence allows? Watch for: installed tags described as active spend; "every page" when fewer were captured; "no X" when X could be blocked or server-side; DataForSEO estimates written as real traffic; one page generalized to the whole company.
4. **Confidence.** For inferred claims, is the confidence level fair given how many signals support it and whether any contradict it?
5. **Contradictions.** Does anything else in the evidence contradict the claim? Check the obvious places: other pages, the stack, the network log.

Also check `at_a_glance` items, the `summary` and every `section_summaries` entry against the claims they condense: a summary must not state anything its section doesn't support, or drop a hedge ("likely", low confidence) the claims carry.

Don't judge writing style, and don't suggest new findings. Only accuracy.

## Output

Write `review.json` in the teardown folder:

```json
{
  "reviewedAt": "ISO timestamp",
  "summary": "Two or three sentences: overall reliability and the main patterns of error.",
  "items": [
    {
      "where": "sections.positioning[0]",
      "verdict": "supported | overstated | mislabeled | unsupported | contradicted",
      "reason": "What the evidence shows, with the file and the exact text or value.",
      "fix": "The corrected claim text, status or confidence. Omit for supported claims."
    }
  ]
}
```

`where` is `summary`, `at_a_glance[i]` or `sections.<key>[i]`. Include every claim, including supported ones, so the count of checked claims is complete. Reply with the number of claims in each verdict and the three most serious problems.
