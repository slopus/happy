interface NameParts {
    firstName: string | null;
    lastName: string | null;
}

export function separateName(fullName: string | null | undefined): NameParts {
    if (!fullName || typeof fullName !== 'string') {
        return { firstName: null, lastName: null };
    }

    const trimmedName = fullName.trim();
    
    if (!trimmedName) {
        return { firstName: null, lastName: null };
    }

    const parts = trimmedName.split(/\s+/);
    
    if (parts.length === 1) {
        return { firstName: parts[0], lastName: null };
    }
    
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');
    
    return { firstName, lastName };
}