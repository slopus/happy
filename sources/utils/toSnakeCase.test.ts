import { describe, it, expect } from 'vitest';
import { toSnakeCase } from './toSnakeCase';

describe('toSnakeCase', () => {
    describe('basic conversions', () => {
        it('should convert simple phrases with spaces', () => {
            expect(toSnakeCase('Hello World')).toBe('hello_world');
            expect(toSnakeCase('This is a test')).toBe('this_is_a_test');
            expect(toSnakeCase('Convert Me Please')).toBe('convert_me_please');
        });

        it('should handle single words', () => {
            expect(toSnakeCase('Hello')).toBe('hello');
            expect(toSnakeCase('WORLD')).toBe('world');
            expect(toSnakeCase('test')).toBe('test');
        });

        it('should handle sentences with punctuation', () => {
            expect(toSnakeCase('Hello World!')).toBe('hello_world');
            expect(toSnakeCase('This is a test sentence.')).toBe('this_is_a_test_sentence');
            expect(toSnakeCase('What? Really? Yes!')).toBe('what_really_yes');
            expect(toSnakeCase('Hello, world; how are you?')).toBe('hello_world_how_are_you');
        });
    });

    describe('special characters handling', () => {
        it('should handle parentheses and brackets', () => {
            expect(toSnakeCase('File (Copy)')).toBe('file_copy');
            expect(toSnakeCase('Array[0]')).toBe('array_0');
            expect(toSnakeCase('Object {key: value}')).toBe('object_key_value');
            expect(toSnakeCase('Tag <html>')).toBe('tag_html');
        });

        it('should handle symbols and special characters', () => {
            expect(toSnakeCase('File (Copy) #2.txt')).toBe('file_copy_2_txt');
            expect(toSnakeCase('Price: $99.99')).toBe('price_99_99');
            expect(toSnakeCase('Email@domain.com')).toBe('email_domain_com');
            expect(toSnakeCase('50% off!')).toBe('50_off');
            expect(toSnakeCase('A&B Company')).toBe('a_b_company');
        });

        it('should handle path-unsafe characters', () => {
            expect(toSnakeCase('folder/file:name*test')).toBe('folder_file_name_test');
            expect(toSnakeCase('file\\path\\name')).toBe('file_path_name');
            expect(toSnakeCase('name:with:colons')).toBe('name_with_colons');
            expect(toSnakeCase('file*name?test')).toBe('file_name_test');
            expect(toSnakeCase('file<name>test')).toBe('file_name_test');
            expect(toSnakeCase('file|name')).toBe('file_name');
            expect(toSnakeCase('"quoted text"')).toBe('quoted_text');
        });

        it('should handle mathematical and currency symbols', () => {
            expect(toSnakeCase('1 + 1 = 2')).toBe('1_1_2');
            expect(toSnakeCase('10 - 5 = 5')).toBe('10_5_5');
            expect(toSnakeCase('3 × 4 = 12')).toBe('3_4_12');
            expect(toSnakeCase('€100 or $120')).toBe('100_or_120');
            expect(toSnakeCase('≈ approximately')).toBe('approximately');
        });
    });

    describe('multiple spaces and underscores', () => {
        it('should collapse multiple spaces', () => {
            expect(toSnakeCase('Hello    World')).toBe('hello_world');
            expect(toSnakeCase('Too  many   spaces')).toBe('too_many_spaces');
            expect(toSnakeCase('Space    between    words')).toBe('space_between_words');
        });

        it('should handle existing underscores', () => {
            expect(toSnakeCase('already_snake_case')).toBe('already_snake_case');
            expect(toSnakeCase('mixed_Snake Case')).toBe('mixed_snake_case');
            expect(toSnakeCase('multiple___underscores')).toBe('multiple_underscores');
        });

        it('should handle mixed separators', () => {
            expect(toSnakeCase('dash-separated words')).toBe('dash_separated_words');
            expect(toSnakeCase('dot.separated.words')).toBe('dot_separated_words');
            expect(toSnakeCase('mixed-separators_and spaces')).toBe('mixed_separators_and_spaces');
        });
    });

    describe('edge cases', () => {
        it('should handle empty and whitespace-only strings', () => {
            expect(toSnakeCase('')).toBe('');
            expect(toSnakeCase('   ')).toBe('');
            expect(toSnakeCase('\t\n')).toBe('');
        });

        it('should handle strings with only special characters', () => {
            expect(toSnakeCase('!!!')).toBe('');
            expect(toSnakeCase('---')).toBe('');
            expect(toSnakeCase('***')).toBe('');
            expect(toSnakeCase('@#$%^&*()')).toBe('');
        });

        it('should handle numbers', () => {
            expect(toSnakeCase('123')).toBe('123');
            expect(toSnakeCase('Test 123')).toBe('test_123');
            expect(toSnakeCase('123 Test')).toBe('123_test');
            expect(toSnakeCase('Test123Test')).toBe('test123test');
        });

        it('should handle leading and trailing special characters', () => {
            expect(toSnakeCase('!!!Hello World!!!')).toBe('hello_world');
            expect(toSnakeCase('...test...')).toBe('test');
            expect(toSnakeCase('___already___')).toBe('already');
            expect(toSnakeCase('  spaces around  ')).toBe('spaces_around');
        });
    });

    describe('unicode and international characters', () => {
        it('should preserve accented characters', () => {
            expect(toSnakeCase('Café')).toBe('café');
            expect(toSnakeCase('naïve')).toBe('naïve');
            expect(toSnakeCase('Zürich')).toBe('zürich');
            expect(toSnakeCase('São Paulo')).toBe('são_paulo');
            expect(toSnakeCase('Montréal')).toBe('montréal');
        });

        it('should handle emoji and special unicode', () => {
            expect(toSnakeCase('Hello 👋 World')).toBe('hello_world');
            expect(toSnakeCase('Test 😀 emoji 🎉')).toBe('test_emoji');
            expect(toSnakeCase('❤️ Love')).toBe('love');
        });

        it('should preserve non-latin scripts', () => {
            expect(toSnakeCase('Hello мир')).toBe('hello_мир');
            expect(toSnakeCase('你好 world')).toBe('你好_world');
            expect(toSnakeCase('مرحبا test')).toBe('مرحبا_test');
            expect(toSnakeCase('こんにちは 世界')).toBe('こんにちは_世界');
            expect(toSnakeCase('Привет мир')).toBe('привет_мир');
        });

        it('should handle mixed scripts properly', () => {
            expect(toSnakeCase('北京 Beijing 2024')).toBe('北京_beijing_2024');
            expect(toSnakeCase('Tokyo 東京')).toBe('tokyo_東京');
            expect(toSnakeCase('Москва Moscow')).toBe('москва_moscow');
        });
    });

    describe('real-world examples', () => {
        it('should handle typical file names', () => {
            expect(toSnakeCase('My Document (Final).docx')).toBe('my_document_final_docx');
            expect(toSnakeCase('Screenshot 2024-01-15 at 10.30.45 AM')).toBe('screenshot_2024_01_15_at_10_30_45_am');
            expect(toSnakeCase('Copy of Budget Q4 2023 (v2)')).toBe('copy_of_budget_q4_2023_v2');
        });

        it('should handle typical user input', () => {
            expect(toSnakeCase("John's Profile Picture")).toBe('john_s_profile_picture');
            expect(toSnakeCase('Meeting Notes - January 15th')).toBe('meeting_notes_january_15th');
            expect(toSnakeCase('TODO: Fix this bug ASAP!')).toBe('todo_fix_this_bug_asap');
        });

        it('should handle programming-related text', () => {
            expect(toSnakeCase('getUserById() function')).toBe('getuserbyid_function');
            expect(toSnakeCase('API_KEY environment variable')).toBe('api_key_environment_variable');
            expect(toSnakeCase('index.html file')).toBe('index_html_file');
        });
    });

    describe('file system safety', () => {
        it('should produce valid filenames for all OS', () => {
            // Windows forbidden characters: < > : " / \ | ? *
            const windowsUnsafe = 'file<name>:test"path"/back\\slash|pipe?mark*star';
            const result = toSnakeCase(windowsUnsafe);
            expect(result).toBe('file_name_test_path_back_slash_pipe_mark_star');
            expect(result).not.toMatch(/[<>:"\/\\|?*]/);
        });

        it('should handle reserved Windows filenames', () => {
            expect(toSnakeCase('CON device')).toBe('con_device');
            expect(toSnakeCase('PRN printer')).toBe('prn_printer');
            expect(toSnakeCase('AUX port')).toBe('aux_port');
            expect(toSnakeCase('NUL device')).toBe('nul_device');
        });

        it('should be safe for git', () => {
            expect(toSnakeCase('.git folder')).toBe('git_folder');
            expect(toSnakeCase('feature/branch-name')).toBe('feature_branch_name');
            expect(toSnakeCase('HEAD~1')).toBe('head_1');
        });
    });
});