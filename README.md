# W3C Community Group Archiver

The W3C Community Group Archiver is a tool that can take a Google Meet meeting
identifier and archive meetings to community-owned infrastructure that is
external to Google.

# Setup

To use the tool, a system needs to have the following installed:

* node.js >= v22

# Installation

To install the tool:

```
npm i
```

# Usage

For any Google Meet meeting you want to archive:

1. Create the Google Meet meeting with recording and transcription turned on.
2. Ensure that the Google email account associated with the OAuth service account is listed as the host or a co-host of the account so the archiver can access the meeting transcripts after they are created.

To set up the tool with OAuth:

1. Create an Google Auth OAuth client and download the oauth credentials into a file named `credentials.json`.
2. Set up the `config.js` file using the `config.example.js` file as a template.
3. Run the `cg-archiver` program and grant it access to access the resources requested. You can specify a date to run the program for using the `--date` flag. Note that by default, Google Meet deletes transcripts after 30 days.

Then, on a daily basis (after all meetings have their transcripts generated -- e.g., at 11pm), run the archiver tool against all meetings to archive them.