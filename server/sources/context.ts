export class Context {

    static create(uid: string) {
        return new Context(uid);
    }

    readonly uid: string;

    private constructor(uid: string) {
        this.uid = uid;
    }
}
