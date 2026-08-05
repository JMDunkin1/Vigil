# Vigil

Vigil is a local-first focus-enforcement app for macOS with supervised iPhone
companions for Instagram and YouTube.

## Agent update commands

Update the installed Vigil Mac app:

```sh
npm run agent:update
```

Update either Personal Team-compatible companion independently on the connected,
paired iPhone:

```sh
npm run agent:update:instagram
npm run agent:update:youtube
```

To check and update both companions in one transaction, run:

```sh
npm run agent:update:phone
```

Agents should run the app-specific command for the companion they are working
on. Each phone command uses the verified deployment suite: it bumps only changed
release inputs, audits all four policy levels, builds and installs only the
selected companion when it needs an update, keeps the matching supervised policy
synchronized, and verifies that companion's resulting device state. It does not
reboot, erase, re-enroll, or weaken supervision.

The iPhone must be unlocked when profile installation needs it, trusted and
paired, visible to Xcode, and reachable through a wired or wireless CoreDevice
connection. USB is not required for normal companion updates. If the
non-removable supervised policy itself has changed, Vigil will ask for USB so it
can retain the verified supervisor-keybag installation transaction. Personal
Team signing remains the supported default and requires no paid Apple Developer
Program membership.
