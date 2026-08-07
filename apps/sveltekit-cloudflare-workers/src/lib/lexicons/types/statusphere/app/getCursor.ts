import type {} from '@atcute/lexicons';
import * as v from '@atcute/lexicons/validations';
import type {} from '@atcute/lexicons/ambient';

const _mainSchema = /*#__PURE__*/ v.query(
	"statusphere.app.getCursor",
	{
		"params": null,
		"output": {
			"type": "lex",
			"schema": /*#__PURE__*/ v.object(
				{
					get "position"() {
						return /*#__PURE__*/ v.optional(sourcePositionSchema)
					},
					"updatedAt": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.integer()),
					"updatedAtDate": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
				}
			),
		}
	}
);
const _sourcePositionSchema = /*#__PURE__*/ v.object({
	"$type": /*#__PURE__*/ v.optional(/*#__PURE__*/ v.literal("statusphere.app.getCursor#sourcePosition")),
	"cursor": /*#__PURE__*/ v.string(),
	"epoch": /*#__PURE__*/ v.string(),
	"source": /*#__PURE__*/ v.string(),
});
type main$schematype = typeof _mainSchema;
type sourcePosition$schematype = typeof _sourcePositionSchema;

export interface mainSchema extends main$schematype {}

export interface sourcePositionSchema extends sourcePosition$schematype {}
export const mainSchema = _mainSchema as mainSchema;
export const sourcePositionSchema = _sourcePositionSchema as sourcePositionSchema;

export interface SourcePosition extends v.InferInput<typeof sourcePositionSchema> {}

export interface $params {}

export interface $output extends v.InferXRPCBodyInput<mainSchema['output']> {}
declare module '@atcute/lexicons/ambient' {
	interface XRPCQueries {
		"statusphere.app.getCursor": mainSchema;
	}
}
