# Contributing to BrainOutput Community Edition

Thanks for your interest. This project is **Apache-2.0** licensed (see [`LICENSE`](LICENSE)).

## License of contributions

By submitting a contribution (a pull request, patch, or any change), you agree it is licensed under
the **Apache License 2.0**, the same license as the project. You retain copyright to your work.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) — a lightweight,
well-understood way to certify you have the right to submit your contribution. **No CLA, no copyright
assignment.**

Sign off every commit by adding a `Signed-off-by` line with your real name and email:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds this automatically. The sign-off certifies the DCO terms below.

<details>
<summary>Developer Certificate of Origin 1.1 (full text)</summary>

```
By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I have the right
    to submit it under the open source license indicated in the file; or
(b) The contribution is based upon previous work that, to the best of my
    knowledge, is covered under an appropriate open source license and I have
    the right under that license to submit that work with modifications; or
(c) The contribution was provided directly to me by some other person who
    certified (a), (b) or (c) and I have not modified it.
(d) I understand and agree that this project and the contribution are public and
    that a record of the contribution (including all personal information I
    submit with it, including my sign-off) is maintained indefinitely and may be
    redistributed consistent with this project or the open source license(s)
    involved.
```
</details>

## Before you open a PR

- Keep the **zero-dependency** rule: no runtime `dependencies` in `package.json` (Node ≥ 18 only).
- Preserve the **hard invariant**: no BrainOutput-funded inference — only user / free / local models.
- Run the tests: `npm test` (and `npm run smoke:community-clean` for install-path changes).
- Match the surrounding style; keep changes small and focused.

## Reporting issues

Security or anything sensitive: **contact@brainoutput.com**. Otherwise open a GitHub issue.
