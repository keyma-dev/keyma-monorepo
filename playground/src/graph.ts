import { Edge, From, To } from "@keyma/dsl";
import type { ID, DateTime, Reference } from "@keyma/dsl";
import { Author } from "./author.js";
import { Post } from "./post.js";
import { Tag } from "./tag.js";

/**
 * A directed edge: one author follows another. Exactly one `@From` and one
 * `@To`; both endpoints are auto-indexed.
 */
@Edge({ name: "FOLLOWS" })
export class Follows {
    declare id: ID;
    declare since: DateTime;

    @From() declare follower: Reference<Author>;
    @To() declare following: Reference<Author>;
}

/**
 * An undirected edge (`directed: false`): a post is related to a tag, traversable
 * from either side.
 */
@Edge({ name: "RELATED", directed: false })
export class Related {
    declare id: ID;

    @From() declare post: Reference<Post>;
    @To() declare tag: Reference<Tag>;
}
