import { Schema, Validate, Format, Indexed, Phase } from "@keyma/dsl";
import type { Reference } from "@keyma/dsl";
import { minLength, maxLength, length, isIpAddress } from "@keyma/validators";
import { normalizeWhitespace, uppercase } from "@keyma/formatters";
import { Entity } from "./base.js";
import { Author } from "./author.js";
import { Post } from "./post.js";

@Schema({ name: "comment", description: "A comment left by an Author on a Post." })
export class Comment extends Entity {

    @Validate(minLength(1), maxLength(1000))
    @Format(Phase.Submit, normalizeWhitespace())
    declare body: string;

    @Indexed()
    declare author: Reference<Author>;

    @Indexed()
    declare post: Reference<Post>;

    // Exact-length code + uppercase normalization.
    @Validate(length(2))
    @Format(Phase.Change, uppercase())
    declare countryCode?: string;

    // IPv4 or IPv6.
    @Validate(isIpAddress())
    declare authorIp?: string;

    score: number = 0;
}
