# frozen_string_literal: true
module Greeter
  class Person < Base
    attr_reader :name
    def initialize(name, age = 30)
      @name = name
      @@count ||= 0
      puts "Hello, #{name}! #{age * 2}"
    end
    def self.parse(str) = str.split(/,\s*/).map(&:strip)
  end
end
