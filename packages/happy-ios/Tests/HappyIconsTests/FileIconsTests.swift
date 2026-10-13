import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyIcons
import HappyLayout
import XCTest

/// components/FileIcon.tsx's icons: the package's lookup and the outlines
/// scripts/generate-file-icons.py wrote.
final class FileIconsTests: XCTestCase {
    /// What @peoplesgrocers/seti-ui-file-icons 1.11.3's `getIcon` answers,
    /// run on the package's own definitions.json.
    func testLookupMatchesThePackage() {
        let expected: [(String, String, SetiColor)] = [
            ("package.json", "json", .yellow),
            ("index.ts", "typescript", .blue),
            ("App.tsx", "react", .blue),
            ("README.md", "info", .blue),
            ("Makefile", "makefile", .orange),
            ("Dockerfile", "docker", .blue),
            ("foo.test.ts", "typescript", .orange),
            ("a.d.ts", "typescript", .blue),
            ("archive.tar.gz", "default", .white),
            (".gitignore", "git", .ignore),
            (".env", "config", .greyLight),
            (".env.local", "default", .white),
            ("Cargo.toml", "config", .greyLight),
            ("main.rs", "rust", .greyLight),
            ("notes", "default", .white),
            ("", "default", .white),
            (".", "default", .white),
            ("x.", "default", .white),
            ("weird.unknownext", "default", .white),
            ("TODO.md", "markdown", .blue),
            ("my.TODO.txt", "default", .white),
            ("CMakeLists.txt", "default", .white),
            ("Procfile", "heroku", .purple),
            ("docker-compose.yml", "yml", .purple),
            ("logo.png", "image", .purple),
            ("icon.svg", "svg", .purple),
            ("style.module.css", "css", .blue),
            ("view.html", "html", .orange),
            ("main.go", "go2", .blue),
            ("yarn.lock", "yarn", .blue),
            ("pnpm-lock.yaml", "yml", .purple),
            ("tsconfig.json", "tsconfig", .blue),
            ("tsconfig.base.json", "json", .yellow),
            ("vite.config.ts", "vite", .yellow),
            ("webpack.config.js", "webpack", .blue),
            ("Gemfile", "ruby", .red),
            ("build.gradle", "gradle", .blue),
            ("x.kt", "kotlin", .orange),
            ("a.R", "R", .blue),
            ("mix.exs", "elixir_script", .purple),
            ("z.ex", "elixir", .purple),
            ("q.pl", "perl", .blue),
            ("karma.conf.js", "karma", .green),
            ("spec.rb", "ruby", .red),
            ("é.swift", "swift", .orange),
            ("Ｋ.md", "markdown", .blue),
            ("gulpfile.js", "javascript", .yellow),
            ("LICENSE", "license", .yellow),
            ("license.txt", "default", .white),
            ("jest.config.ts", "typescript", .blue),
        ]
        for (name, icon, color) in expected {
            let found = FileIcons.lookup(name)
            XCTAssertEqual(found.icon, icon, name)
            XCTAssertEqual(found.color, color, name)
        }
    }

    func testEveryIconParses() {
        XCTAssertEqual(FileIcons.sourceVersion, "1.11.3")
        let lines = GeneratedFileIcons.icons.split(separator: "\n")
        XCTAssertEqual(FileIcons.allIcons.count, 151)
        XCTAssertEqual(lines.count, 151)
        for line in lines {
            let name = String(line.split(separator: " ")[0])
            let shapes = line.split(separator: " ", maxSplits: 2)[2].split(separator: ";").count
            guard let outline = FileIcons.outlines[name] else {
                XCTFail("\(name) doesn't parse")
                continue
            }
            XCTAssertEqual(outline.shapes.count, shapes, name)
            XCTAssertGreaterThan(outline.viewBox.width, 0, name)
            for shape in outline.shapes {
                XCTAssertFalse(shape.path.elements.isEmpty, name)
                XCTAssertGreaterThan(shape.opacity, 0, name)
                XCTAssertLessThanOrEqual(shape.opacity, 1, name)
            }
        }
    }

    func testEveryDefinitionNamesAnIcon() {
        for table in [GeneratedFileIcons.files, GeneratedFileIcons.extensions, GeneratedFileIcons.partials] {
            for line in table.split(separator: "\n") {
                let parts = line.split(separator: " ")
                XCTAssertEqual(parts.count, 3, String(line))
                XCTAssertNotNil(FileIcons.outlines[String(parts[1])], String(line))
                XCTAssertNotNil(SetiColor(rawValue: String(parts[2])), String(line))
            }
        }
        XCTAssertNotNil(FileIcons.icon(for: "anything"))
    }

    func testShapesKeepTheirRuleAndOpacity() throws {
        // font.svg: a 60% shape under a solid one.
        let font = try XCTUnwrap(FileIcons.outlines["font"])
        XCTAssertEqual(font.shapes.map(\.opacity), [0.6, 1])
        // gradle draws through <use fill-rule="evenodd">.
        let gradle = try XCTUnwrap(FileIcons.outlines["gradle"])
        XCTAssertEqual(gradle.shapes.map(\.evenOdd), [true])
        // prolog's two circles became closed curves.
        let prolog = try XCTUnwrap(FileIcons.outlines["prolog"])
        XCTAssertEqual(prolog.shapes.count, 3)
        XCTAssertEqual(prolog.shapes[1].path.elements.last, .close)
    }

    func testFitsLikeSvgXml() throws {
        // A 1200 x 1000 view box in a 16pt square: scaled by 16/1200,
        // centred vertically.
        let icon = try XCTUnwrap(FileIcons.icon(for: "notes"))
        XCTAssertEqual(icon.name, "default")
        XCTAssertEqual(icon.viewBox, CGRect(x: 0, y: 0, width: 1200, height: 1000))
        let fitted = icon.fitted(into: CGRect(x: 0, y: 0, width: 16, height: 16))
        let bounds = fitted[0].path.controlBounds
        let source = icon.shapes[0].path.controlBounds
        let scale: CGFloat = 16 / 1200
        XCTAssertEqual(bounds.minX, source.minX * scale, accuracy: 0.0001)
        XCTAssertEqual(bounds.minY, source.minY * scale + (16 - 1000 * scale) / 2, accuracy: 0.0001)
        XCTAssertEqual(bounds.width, source.width * scale, accuracy: 0.0001)
    }
}
