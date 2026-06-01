export class User {
    constructor(value) {
        if (value) {
            this.id = value.id;
            this.firstName = value.firstName;
            this.lastName = value.lastName;
            this.secretNote = value.secretNote;
        }
    }

    get fullName() {
        return `${this.firstName} ${this.lastName}`;
    }
}

User.schema = Object.freeze({
    "name": "user",
    "sourceName": "User",
    "fields": [
        {
            "name": "id",
            "type": {
                "kind": "id"
            },
            "readonly": true,
            "validators": [
                {
                    "name": "required"
                }
            ],
            "indexes": [
                {
                    "unique": true
                }
            ]
        },
        {
            "name": "firstName",
            "type": {
                "kind": "string"
            },
            "validators": [
                {
                    "name": "minLength",
                    "params": {
                        "value": 2
                    }
                }
            ],
            "formatters": [
                {
                    "phase": "change",
                    "spec": {
                        "name": "trim"
                    }
                }
            ]
        },
        {
            "name": "lastName",
            "type": {
                "kind": "string"
            }
        },
        {
            "name": "secretNote",
            "type": {
                "kind": "string"
            },
            "visibility": "private",
            "required": false
        },
        {
            "name": "fullName",
            "type": {
                "kind": "string"
            },
            "readonly": true,
            "computed": true
        }
    ],
    "indexes": [
        {
            "fields": [
                {
                    "name": "firstName",
                    "direction": 1
                }
            ],
            "unique": false
        }
    ]
});

export function materializeUser(value) {
    value.fullName = `${value.firstName} ${value.lastName}`;
    return value;
}
