import type {} from '@atcute/lexicons';
import * as v from '@atcute/lexicons/validations';
import type {} from '@atcute/lexicons/ambient';
import * as ComAtprotoLabelDefs from "@atcute/atproto/types/label/defs";
import * as ComAtprotoRepoStrongRef from "@atcute/atproto/types/repo/strongRef";

const _appBskyActorProfileSchema = /*#__PURE__*/ v.object(
	{
		"$type": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.literal("statusphere.app.getProfile#appBskyActorProfile")),
		/**
		 * Small image to be displayed next to posts from account. AKA, 'profile picture'
		 * @accept image/png, image/jpeg
		 * @maxSize 1000000
		 */
		"avatar": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.blob(),
			[
				/*#__PURE__*/ v.blobSize(1000000),
				/*#__PURE__*/ v.blobAccept(["image/png", "image/jpeg"])
			]
		)),
		/**
		 * Larger horizontal image to display behind profile view.
		 * @accept image/png, image/jpeg
		 * @maxSize 1000000
		 */
		"banner": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.blob(),
			[
				/*#__PURE__*/ v.blobSize(1000000),
				/*#__PURE__*/ v.blobAccept(["image/png", "image/jpeg"])
			]
		)),
		"createdAt": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
		/**
		 * Free-form profile description text.
		 * @maxLength 2560
		 * @maxGraphemes 256
		 */
		"description": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.string(),
			[
				/*#__PURE__*/ v.stringLength(0, 2560),
				/*#__PURE__*/ v.stringGraphemes(0, 256)
			]
		)),
		/**
		 * @maxLength 640
		 * @maxGraphemes 64
		 */
		"displayName": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.string(),
			[
				/*#__PURE__*/ v.stringLength(0, 640),
				/*#__PURE__*/ v.stringGraphemes(0, 64)
			]
		)),
		get "joinedViaStarterPack"() {
			return /*#__PURE__*/ v.optional(ComAtprotoRepoStrongRef.mainSchema)
		},
		/**
		 * Self-label values, specific to the Bluesky application, on the overall account.
		 */
		get "labels"() {
			return /*#__PURE__*/ v.optional(/*#__PURE__*/ v.variant([ComAtprotoLabelDefs.selfLabelsSchema]))
		},
		get "pinnedPost"() {
			return /*#__PURE__*/ v.optional(ComAtprotoRepoStrongRef.mainSchema)
		},
		/**
		 * Free-form pronouns text.
		 * @maxLength 200
		 * @maxGraphemes 20
		 */
		"pronouns": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.string(),
			[
				/*#__PURE__*/ v.stringLength(0, 200),
				/*#__PURE__*/ v.stringGraphemes(0, 20)
			]
		)),
		"website": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.genericUriString()),
	}
);
const _mainSchema = /*#__PURE__*/ v.query(
	"statusphere.app.getProfile",
	{
		"params": /*#__PURE__*/ v.object(
			{
				/**
				 * DID or handle of the user
				 */
				"actor": /*#__PURE__*/ v.actorIdentifierString(),
			}
		),
		"output": {
			"type": "lex",
			"schema": /*#__PURE__*/ v.object(
				{
					get "profiles"() {
						return /*#__PURE__*/ v.array(profileEntrySchema)
					},
				}
			),
		}
	}
);
const _profileEntrySchema = /*#__PURE__*/ v.object(
	{
		"$type": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.literal("statusphere.app.getProfile#profileEntry")),
		"cid": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.cidString()),
		"collection": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.nsidString()),
		"did": /*#__PURE__*/ v.didString(),
		"handle": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
		"rkey": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.string()),
		"uri": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.resourceUriString()),
		get "value"() {
			return /*#__PURE__*/ v.optional(appBskyActorProfileSchema)
		},
	}
);
type appBskyActorProfile$schematype = typeof _appBskyActorProfileSchema;
type main$schematype = typeof _mainSchema;
type profileEntry$schematype = typeof _profileEntrySchema;

export interface appBskyActorProfileSchema extends appBskyActorProfile$schematype {}

export interface mainSchema extends main$schematype {}

export interface profileEntrySchema extends profileEntry$schematype {}
export const appBskyActorProfileSchema = _appBskyActorProfileSchema as appBskyActorProfileSchema;
export const mainSchema = _mainSchema as mainSchema;
export const profileEntrySchema = _profileEntrySchema as profileEntrySchema;

export interface AppBskyActorProfile extends v.InferInput<typeof appBskyActorProfileSchema> {}

export interface ProfileEntry extends v.InferInput<typeof profileEntrySchema> {}

export interface $params extends v.InferInput<mainSchema['params']> {}

export interface $output extends v.InferXRPCBodyInput<mainSchema['output']> {}
declare module '@atcute/lexicons/ambient' {
	interface XRPCQueries {
		"statusphere.app.getProfile": mainSchema;
	}
}
