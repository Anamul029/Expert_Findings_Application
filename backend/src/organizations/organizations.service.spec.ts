import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrganizationsService } from './organizations.service';
import { Organization } from './entities/organization.entity';

// Mock the entire @nestjs/typeorm module to avoid ESM loading issues
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: jest.fn().mockImplementation(() => jest.fn()),
  getRepositoryToken: jest.fn().mockReturnValue('mock-token'),
  TypeOrmModule: { forFeature: jest.fn() },
}));

// Create the fake repository
const mockRepository = {
  find: jest.fn(),
};

describe('OrganizationsService', () => {
  let service: OrganizationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        {
          provide: getRepositoryToken(Organization),
          useValue: mockRepository,
        },
        //Provide the Repository class token as a fallback
        {
          provide: Repository,
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<OrganizationsService>(OrganizationsService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return an array of organizations', async () => {
    // Arrange
    const fakeOrganizations: Organization[] = [
      { id: 1, name: 'Google', type: 'Tech' },
      { id: 2, name: 'Microsoft', type: 'Tech' },
    ];
    mockRepository.find.mockResolvedValue(fakeOrganizations);

    // Act
    const result = await service.findAll();

    // Assert
    expect(result).toEqual(fakeOrganizations);
    expect(mockRepository.find).toHaveBeenCalledTimes(1);
  });

  it('should throw an error if repository fails', async () => {
    // Arrange
    const error = new Error('Database connection lost');
    mockRepository.find.mockRejectedValue(error);

    // Act & Assert
    await expect(service.findAll()).rejects.toThrow('Database connection lost');
  });
});
