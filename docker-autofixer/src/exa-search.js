const axios = require('axios');

class ExaSearchClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.exa.ai';
  }

  async searchForSolution(query, type = 'code') {
    try {
      const response = await axios.post(
        `${this.baseUrl}/search`,
        {
          query: `${type} solution: ${query}`,
          type: 'neural',
          useAutoprompt: true,
          numResults: 5,
          contents: {
            text: true,
            highlights: true,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data;
    } catch (error) {
      console.error('Exa search failed:', error.message);
      return null;
    }
  }

  async findBestPractices(technology, issue) {
    const query = `${technology} best practices ${issue} fix solution`;
    return await this.searchForSolution(query, 'documentation');
  }

  async findErrorSolutions(errorMessage, language = 'typescript') {
    const query = `${language} error "${errorMessage}" solution fix`;
    return await this.searchForSolution(query, 'stackoverflow');
  }
}

module.exports = ExaSearchClient;
