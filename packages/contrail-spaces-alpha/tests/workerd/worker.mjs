import { P256Keypair } from "@atproto/crypto";
import {
  computeCommitMac,
  computeRecordMac,
  formatMacHeader,
  parseWantMacHeader,
  RECORD_MAC_TYPE,
  decapsulate,
  encapsulate,
  RepoCommit,
  serializeRecord,
  serializeRepo,
  verifyRepoStarFull,
  verifyCredentialSig,
} from "@atproto/space";
import {
  SpaceCredentialTransport,
  getPublishedSpacePolicy,
} from "../../dist/index.js";
import { createSpacesWorker } from "../../dist/worker.js";

const collection = "garden.example.note";
const space = "at://did:plc:alice/space/garden.example.circle/self";
const provider = createSpacesWorker({
  projection: {
    namespace: "garden.example.circle",
    profiles: [],
    collections: { note: { collection, validate: true } },
  },
  lexicons: [
    {
      lexicon: 1,
      id: collection,
      defs: {
        main: {
          type: "record",
          key: "any",
          record: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string" } },
          },
        },
      },
    },
  ],
  spaceTypes: {
    "garden.example.circle": {
      collections: [collection],
      policy: { $type: "com.atproto.memberspace.policy" },
    },
  },
  service: {
    endpoint: "https://spaces.example",
    audience: "did:web:spaces.example#spaces",
  },
});
export default {
  async fetch(_request, env, ctx) {
    const kem = await P256Keypair.create({ exportable: true });
    const { keyShare, sharedSecret } = await encapsulate(kem.did());
    const hostSecret = await decapsulate(kem, keyShare);
    const record = await serializeRecord(collection, "one", {
      $type: collection,
      text: "private",
    });
    const commit = RepoCommit.fromRecords([record]).toCommit({
      space,
      repo: "did:plc:alice",
      rev: "3h4oqw2vvxpwz",
    });
    const verified = await verifyRepoStarFull(serializeRepo(commit, [record]), {
      space,
      repo: "did:plc:alice",
      sharedSecret,
      mac: computeCommitMac(hostSecret, commit),
    });
    const transport = new SpaceCredentialTransport(
      "local-credential",
      kem,
      Date.now() + 60_000,
      async (request) => {
        await verifyCredentialSig(
          Object.fromEntries(request.headers.entries()),
          kem.did(),
        );
        if (new URL(request.url).pathname.endsWith("getRecord")) {
          const share = parseWantMacHeader(
            request.headers.get("Atproto-Space-Want-Mac"),
            RECORD_MAC_TYPE,
          );
          const secret = await decapsulate(kem, share);
          const value = {
            $type: "com.atproto.space.policy",
            policy: {
              $type: "com.atproto.memberspace.policy",
              publishPolicy: true,
            },
          };
          const policyRecord = await serializeRecord(
            "com.atproto.space.policy",
            "self",
            value,
          );
          const uri = `${space}/did:plc:alice/com.atproto.space.policy/self`;
          return Response.json(
            { uri, cid: policyRecord.cid.toString(), value },
            {
              headers: {
                "Atproto-Space-Mac": formatMacHeader(
                  RECORD_MAC_TYPE,
                  computeRecordMac(secret, uri, policyRecord.cid),
                ),
              },
            },
          );
        }
        return Response.json({ signed: true });
      },
    );
    const signed = await transport.fetch(
      "https://unused.example/xrpc/local",
      {},
      "did:plc:alice",
    );
    const policy = await getPublishedSpacePolicy(
      transport,
      "https://unused.example",
      space,
      { kemDidKey: kem.did() },
    );
    const listed = await provider
      .integrated(
        {
          ...env,
          SPACES_CREDENTIAL_ENCRYPTION_KEY:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
        ctx,
      )
      .listSpaces({ userDid: "did:plc:alice" });
    return Response.json({
      star: verified.records.length === 1,
      policy: policy.publishPolicy === true,
      signature: (await signed.json()).signed,
      privateD1: listed.spaces.length === 0,
    });
  },
};
